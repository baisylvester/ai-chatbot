/**
 * Voice provider adapters behind normalized interfaces:
 *  - SpeechToText: audio bytes → text
 *  - TextToSpeech: text → audio bytes
 *  - Realtime: mint a short-lived client secret so the browser can open a WebRTC voice session
 *    directly with the provider, without ever seeing the permanent API key.
 * Capabilities are declared per provider and checked, not assumed.
 * Credentials come only from server env.
 */

export type VoiceProviderId = "openai" | "elevenlabs" | "mock";
export type VoiceEnv = Record<string, string | undefined>;
type FetchLike = typeof fetch;

export interface VoiceCapabilities {
  stt: boolean;
  tts: boolean;
  realtime: boolean;
}

export interface VoiceInfo {
  id: string;
  name: string;
}

export interface Transcription {
  text: string;
}

export interface SpeechAudio {
  audio: Uint8Array;
  mimeType: string;
}

export interface RealtimeSecret {
  clientSecret: string;
  /** Seconds since epoch */
  expiresAt: number;
  model: string;
  voice: string;
  /** Where the browser posts its SDP offer (Authorization: Bearer <clientSecret>). */
  callsUrl: string;
}

export interface RealtimeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export class VoiceError extends Error {
  readonly code: "not_configured" | "unsupported" | "provider_error" | "invalid";
  constructor(code: VoiceError["code"], message: string) {
    super(message);
    this.name = "VoiceError";
    this.code = code;
  }
}

const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];
const OPENAI_REALTIME_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"];

export const capabilities: Record<VoiceProviderId, VoiceCapabilities> = {
  openai: { stt: true, tts: true, realtime: true },
  elevenlabs: { stt: true, tts: true, realtime: false },
  mock: { stt: true, tts: true, realtime: false },
};

const required: Record<VoiceProviderId, string[]> = {
  openai: ["OPENAI_API_KEY"],
  elevenlabs: ["ELEVENLABS_API_KEY"],
  mock: [],
};

export function isVoiceProviderConfigured(id: VoiceProviderId, env: VoiceEnv): boolean {
  if (id === "mock") return env.VOICE_MOCK === "1";
  return required[id].every((k) => env[k]?.trim());
}

export function listVoiceProviders(env: VoiceEnv) {
  return (Object.keys(capabilities) as VoiceProviderId[])
    .filter((id) => id !== "mock" || env.VOICE_MOCK === "1")
    .map((id) => ({ id, configured: isVoiceProviderConfigured(id, env), capabilities: capabilities[id] }));
}

function assertUsable(id: VoiceProviderId, cap: keyof VoiceCapabilities, env: VoiceEnv) {
  if (!capabilities[id]?.[cap]) throw new VoiceError("unsupported", `${id} does not support ${cap === "stt" ? "speech-to-text" : cap === "tts" ? "text-to-speech" : "realtime voice"}`);
  if (!isVoiceProviderConfigured(id, env)) {
    throw new VoiceError("not_configured", id === "mock" ? "The mock voice provider is disabled (VOICE_MOCK=1)" : `${id} voice is not configured on the server (missing ${required[id].join(", ")})`);
  }
}

async function providerError(res: Response, provider: string): Promise<VoiceError> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; detail?: { message?: string } | string };
    const e = body.error ?? body.detail;
    detail = typeof e === "string" ? e : (e?.message ?? "");
  } catch {
    /* non-JSON */
  }
  return new VoiceError("provider_error", `${provider} returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
}

// ------------------------------------------------------------------ voice catalog

export async function listVoices(id: VoiceProviderId, env: VoiceEnv, fetchImpl: FetchLike = fetch): Promise<VoiceInfo[]> {
  if (id === "openai") return OPENAI_VOICES.map((v) => ({ id: v, name: v[0]!.toUpperCase() + v.slice(1) }));
  if (id === "mock") return [{ id: "tone", name: "Test tone" }];
  if (!isVoiceProviderConfigured("elevenlabs", env)) return [];
  const res = await fetchImpl("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": env.ELEVENLABS_API_KEY! } });
  if (!res.ok) throw await providerError(res, "ElevenLabs");
  const body = (await res.json()) as { voices?: { voice_id: string; name: string }[] };
  return (body.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name }));
}

export function realtimeVoices(): string[] {
  return [...OPENAI_REALTIME_VOICES];
}

// ------------------------------------------------------------------ speech-to-text

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export async function transcribe(
  id: VoiceProviderId,
  audio: Uint8Array,
  mimeType: string,
  env: VoiceEnv,
  opts: { language?: string; fetchImpl?: FetchLike } = {},
): Promise<Transcription> {
  assertUsable(id, "stt", env);
  if (audio.byteLength === 0) throw new VoiceError("invalid", "No audio was recorded");
  if (audio.byteLength > MAX_AUDIO_BYTES) throw new VoiceError("invalid", "The recording is too long");
  const doFetch = opts.fetchImpl ?? fetch;
  const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") || mimeType.includes("m4a") ? "m4a" : mimeType.includes("wav") ? "wav" : mimeType.includes("mpeg") ? "mp3" : "webm";
  const file = new Blob([new Uint8Array(audio)], { type: mimeType || "audio/webm" });

  if (id === "mock") return { text: "This is a mock transcript." };

  const form = new FormData();
  if (id === "openai") {
    form.append("file", file, `speech.${ext}`);
    form.append("model", env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe");
    if (opts.language) form.append("language", opts.language);
    const res = await doFetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!res.ok) throw await providerError(res, "OpenAI");
    return { text: String(((await res.json()) as { text?: string }).text ?? "").trim() };
  }

  form.append("file", file, `speech.${ext}`);
  form.append("model_id", env.ELEVENLABS_STT_MODEL || "scribe_v1");
  if (opts.language) form.append("language_code", opts.language);
  const res = await doFetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY! },
    body: form,
  });
  if (!res.ok) throw await providerError(res, "ElevenLabs");
  return { text: String(((await res.json()) as { text?: string }).text ?? "").trim() };
}

// ------------------------------------------------------------------ text-to-speech

export const MAX_TTS_CHARS = 2000;

/** Removes citation markers and Markdown symbols that shouldn't be read aloud. */
export function speakableText(text: string): string {
  return text
    .replace(/\[\d+\](\[\d+\])*/g, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TTS_CHARS);
}

/** A short sine tone as 16-bit mono WAV (mock provider). */
export function toneWav(seconds = 0.4, hz = 440, rate = 16000): Uint8Array {
  const samples = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), 44 + i * 2);
  return new Uint8Array(buf);
}

export async function synthesize(
  id: VoiceProviderId,
  text: string,
  voice: string,
  env: VoiceEnv,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<SpeechAudio> {
  assertUsable(id, "tts", env);
  const input = speakableText(text);
  if (!input) throw new VoiceError("invalid", "Nothing to read aloud");
  const doFetch = opts.fetchImpl ?? fetch;

  if (id === "mock") return { audio: toneWav(), mimeType: "audio/wav" };

  if (id === "openai") {
    const res = await doFetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
        voice: OPENAI_VOICES.includes(voice) ? voice : "alloy",
        input,
        response_format: "mp3",
      }),
    });
    if (!res.ok) throw await providerError(res, "OpenAI");
    return { audio: new Uint8Array(await res.arrayBuffer()), mimeType: "audio/mpeg" };
  }

  if (!/^[A-Za-z0-9]{8,64}$/.test(voice)) throw new VoiceError("invalid", "Set an ElevenLabs voice id in the chatbot's voice settings");
  const res = await doFetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY!, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text: input, model_id: env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5" }),
  });
  if (!res.ok) throw await providerError(res, "ElevenLabs");
  return { audio: new Uint8Array(await res.arrayBuffer()), mimeType: "audio/mpeg" };
}

// ------------------------------------------------------------------ realtime (OpenAI)

/**
 * Mints a short-lived client secret for an OpenAI Realtime WebRTC session. The browser uses it once
 * to POST its SDP offer to `callsUrl`; the permanent API key never leaves the server.
 */
export async function createRealtimeSecret(
  env: VoiceEnv,
  session: { model: string; voice: string; instructions: string; tools?: RealtimeTool[]; ttlSeconds?: number },
  opts: { fetchImpl?: FetchLike } = {},
): Promise<RealtimeSecret> {
  assertUsable("openai", "realtime", env);
  const voice = OPENAI_REALTIME_VOICES.includes(session.voice) ? session.voice : "marin";
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: Math.min(Math.max(session.ttlSeconds ?? 60, 10), 600) },
      session: {
        type: "realtime",
        model: session.model,
        instructions: session.instructions,
        audio: {
          input: {
            transcription: { model: env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe" },
            turn_detection: { type: "semantic_vad" },
          },
          output: { voice },
        },
        tools: (session.tools ?? []).map((t) => ({ type: "function", ...t })),
        tool_choice: "auto",
        max_output_tokens: 1024,
      },
    }),
  });
  if (!res.ok) throw await providerError(res, "OpenAI");
  const body = (await res.json()) as { value?: string; expires_at?: number };
  if (!body.value) throw new VoiceError("provider_error", "OpenAI did not return a client secret");
  return {
    clientSecret: body.value,
    expiresAt: body.expires_at ?? Math.floor(Date.now() / 1000) + 60,
    model: session.model,
    voice,
    callsUrl: "https://api.openai.com/v1/realtime/calls",
  };
}
