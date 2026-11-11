import { describe, expect, it } from "vitest";
import {
  createRealtimeSecret,
  isVoiceProviderConfigured,
  listVoiceProviders,
  listVoices,
  speakableText,
  synthesize,
  toneWav,
  transcribe,
  VoiceError,
} from "../src/index.ts";

type Call = { url: string; init: RequestInit };
function recorder(response: () => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const env = { OPENAI_API_KEY: "sk-test", ELEVENLABS_API_KEY: "el-test" };
const audio = new Uint8Array([1, 2, 3, 4]);

describe("configuration and capabilities", () => {
  it("reports configuration per provider and hides the mock unless enabled", () => {
    expect(isVoiceProviderConfigured("openai", {})).toBe(false);
    expect(isVoiceProviderConfigured("elevenlabs", env)).toBe(true);
    expect(listVoiceProviders({}).map((p) => p.id)).toEqual(["openai", "elevenlabs"]);
    expect(listVoiceProviders({ VOICE_MOCK: "1" }).map((p) => p.id)).toContain("mock");
    expect(JSON.stringify(listVoiceProviders(env))).not.toContain("sk-test");
  });

  it("refuses unsupported or unconfigured operations with clear errors", async () => {
    await expect(createRealtimeSecret({}, { model: "gpt-realtime", voice: "marin", instructions: "x" })).rejects.toMatchObject({ code: "not_configured" });
    await expect(transcribe("openai", audio, "audio/webm", {})).rejects.toThrow(/OPENAI_API_KEY/);
    await expect(transcribe("mock", audio, "audio/webm", {})).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("speech-to-text", () => {
  it("sends audio to OpenAI as multipart with the transcription model", async () => {
    const { calls, fetchImpl } = recorder(() => Response.json({ text: " Hello there " }));
    expect(await transcribe("openai", audio, "audio/webm;codecs=opus", env, { fetchImpl })).toEqual({ text: "Hello there" });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect((form.get("file") as File).name).toBe("speech.webm");
  });

  it("uses ElevenLabs Scribe with the xi-api-key header", async () => {
    const { calls, fetchImpl } = recorder(() => Response.json({ text: "Kumusta" }));
    expect((await transcribe("elevenlabs", audio, "audio/ogg", env, { fetchImpl, language: "fil" })).text).toBe("Kumusta");
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect((calls[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe("el-test");
    expect((calls[0]!.init.body as FormData).get("language_code")).toBe("fil");
  });

  it("rejects empty audio and surfaces provider errors", async () => {
    await expect(transcribe("openai", new Uint8Array(), "audio/webm", env)).rejects.toMatchObject({ code: "invalid" });
    const { fetchImpl } = recorder(() => Response.json({ error: { message: "Invalid file format" } }, { status: 400 }));
    await expect(transcribe("openai", audio, "audio/webm", env, { fetchImpl })).rejects.toThrow("OpenAI returned HTTP 400: Invalid file format");
  });
});

describe("text-to-speech", () => {
  it("strips citations and markdown before speaking", () => {
    expect(speakableText("Open **9am** to 6pm [1][2]. See `docs` #info")).toBe("Open 9am to 6pm . See docs info");
  });

  it("calls OpenAI speech with a known voice and returns MP3", async () => {
    const { calls, fetchImpl } = recorder(() => new Response(new Uint8Array([9, 9]), { headers: { "content-type": "audio/mpeg" } }));
    const out = await synthesize("openai", "Hello [1]", "coral", env, { fetchImpl });
    expect(out).toEqual({ audio: new Uint8Array([9, 9]), mimeType: "audio/mpeg" });
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ voice: "coral", input: "Hello", response_format: "mp3" });
    const bad = recorder(() => new Response(new Uint8Array([1])));
    await synthesize("openai", "Hi", "not-a-voice", env, { fetchImpl: bad.fetchImpl });
    expect(JSON.parse(bad.calls[0]!.init.body as string).voice).toBe("alloy");
  });

  it("validates ElevenLabs voice ids before building the URL", async () => {
    await expect(synthesize("elevenlabs", "Hi", "../../v1/user", env)).rejects.toMatchObject({ code: "invalid" });
    const { calls, fetchImpl } = recorder(() => new Response(new Uint8Array([1])));
    await synthesize("elevenlabs", "Hi", "21m00Tcm4TlvDq8ikWAM", env, { fetchImpl });
    expect(calls[0]!.url).toMatch(/^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/21m00Tcm4TlvDq8ikWAM\?/);
  });

  it("mock provider returns a valid WAV tone", async () => {
    const wav = toneWav();
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect((await synthesize("mock", "Hi", "tone", { VOICE_MOCK: "1" })).mimeType).toBe("audio/wav");
  });
});

describe("realtime", () => {
  it("mints a client secret with session config and tools, never returning the API key", async () => {
    const { calls, fetchImpl } = recorder(() => Response.json({ value: "ek_abc", expires_at: 1900000000 }));
    const secret = await createRealtimeSecret(
      env,
      {
        model: "gpt-realtime",
        voice: "cedar",
        instructions: "Be brief.",
        tools: [{ name: "search_knowledge", description: "Search", parameters: { type: "object" } }],
      },
      { fetchImpl },
    );
    expect(secret).toEqual({ clientSecret: "ek_abc", expiresAt: 1900000000, model: "gpt-realtime", voice: "cedar", callsUrl: "https://api.openai.com/v1/realtime/calls" });
    expect(JSON.stringify(secret)).not.toContain("sk-test");
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.session).toMatchObject({
      type: "realtime",
      model: "gpt-realtime",
      instructions: "Be brief.",
      audio: { output: { voice: "cedar" } },
      tools: [{ type: "function", name: "search_knowledge" }],
    });
    expect(body.expires_after).toEqual({ anchor: "created_at", seconds: 60 });
  });

  it("falls back to a valid realtime voice", async () => {
    const { calls, fetchImpl } = recorder(() => Response.json({ value: "ek_x" }));
    const s = await createRealtimeSecret(env, { model: "gpt-realtime", voice: "fable", instructions: "x" }, { fetchImpl });
    expect(s.voice).toBe("marin");
    expect(JSON.parse(calls[0]!.init.body as string).session.audio.output.voice).toBe("marin");
  });
});

describe("voice catalog", () => {
  it("lists OpenAI voices locally and ElevenLabs voices from the API", async () => {
    expect((await listVoices("openai", {})).map((v) => v.id)).toContain("marin");
    const { fetchImpl } = recorder(() => Response.json({ voices: [{ voice_id: "abc12345", name: "Rachel" }] }));
    expect(await listVoices("elevenlabs", env, fetchImpl)).toEqual([{ id: "abc12345", name: "Rachel" }]);
    expect(await listVoices("elevenlabs", {})).toEqual([]);
  });

  it("VoiceError is exported for callers", () => {
    expect(new VoiceError("invalid", "x")).toBeInstanceOf(Error);
  });
});
