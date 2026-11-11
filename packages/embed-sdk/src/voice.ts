/** Browser voice helpers: push-to-talk recording, reply playback, and realtime WebRTC calls. */
import type { ChatClient, Citation, RealtimeStart } from "./client.ts";

export const voiceSupported = {
  record: () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined",
  realtime: () => typeof RTCPeerConnection !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
};

export function micErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was blocked. Allow it in your browser settings to talk.";
  if (name === "NotFoundError") return "No microphone was found.";
  return "The microphone couldn't be started.";
}

/** Records one utterance. Stops automatically after `maxMs`. */
export class Recorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private started = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resolveStop: ((r: { blob: Blob; durationMs: number }) => void) | null = null;

  get recording() {
    return this.recorder?.state === "recording";
  }

  async start(maxMs = 60_000): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported?.(m));
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.recorder?.mimeType || "audio/webm" });
      this.release();
      this.resolveStop?.({ blob, durationMs: Date.now() - this.started });
      this.resolveStop = null;
    };
    this.started = Date.now();
    this.recorder.start();
    this.timer = setTimeout(() => void this.stop(), maxMs);
  }

  stop(): Promise<{ blob: Blob; durationMs: number }> {
    return new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === "inactive") {
        resolve({ blob: new Blob(), durationMs: 0 });
        return;
      }
      this.resolveStop = resolve;
      this.recorder.stop();
    });
  }

  cancel() {
    this.resolveStop = null;
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.onstop = () => this.release();
      this.recorder.stop();
    } else this.release();
  }

  private release() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/** Plays one reply at a time; starting a new one (or the visitor typing) stops the previous one. */
export class Speaker {
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private abort: AbortController | null = null;

  async play(client: ChatClient, text: string): Promise<void> {
    this.stop();
    this.abort = new AbortController();
    const blob = await client.speak(text, this.abort.signal);
    this.url = URL.createObjectURL(blob);
    this.audio = new Audio(this.url);
    this.audio.addEventListener("ended", () => this.stop(), { once: true });
    await this.audio.play();
  }

  get playing() {
    return !!this.audio && !this.audio.paused;
  }

  stop() {
    this.abort?.abort();
    this.abort = null;
    this.audio?.pause();
    this.audio = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}

export type CallStatus = "connecting" | "listening" | "speaking" | "ended" | "dropped";

export interface CallEvents {
  onStatus(status: CallStatus, detail?: string): void;
  onTranscript(role: "user" | "assistant", text: string): void;
  onCitations?(citations: Citation[]): void;
}

/**
 * A realtime voice call. The browser connects straight to the provider over WebRTC using a
 * short-lived secret from our API; knowledge lookups go through our API so they stay scoped to
 * this chatbot. Interruptions are handled by the provider's voice activity detection.
 */
export class RealtimeCall {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private session: RealtimeStart | null = null;
  private transcript: { role: "user" | "assistant"; text: string }[] = [];
  private finished = false;
  private readonly client: ChatClient;
  private readonly events: CallEvents;

  constructor(client: ChatClient, events: CallEvents) {
    this.client = client;
    this.events = events;
  }

  async start(): Promise<void> {
    this.events.onStatus("connecting");
    this.session = await this.client.startRealtime();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });

    const pc = new RTCPeerConnection();
    this.pc = pc;
    this.audio = new Audio();
    this.audio.autoplay = true;
    pc.ontrack = (e) => {
      if (this.audio) this.audio.srcObject = e.streams[0] ?? null;
    };
    this.stream.getTracks().forEach((t) => pc.addTrack(t, this.stream!));
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") void this.end(true, "The call was disconnected.");
    };

    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.addEventListener("message", (e) => void this.onEvent(e.data));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await fetch(this.session.callsUrl, {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${this.session.clientSecret}`, "Content-Type": "application/sdp" },
    });
    if (!res.ok) throw new Error(`Voice service refused the call (${res.status})`);
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    this.events.onStatus("listening");
  }

  private send(event: Record<string, unknown>) {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(event));
  }

  private async onEvent(raw: unknown) {
    let event: { type?: string; [k: string]: unknown };
    try {
      event = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.events.onStatus("listening");
        break;
      case "response.created":
        this.events.onStatus("speaking");
        break;
      case "response.done":
        this.events.onStatus("listening");
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(event.transcript ?? "").trim();
        if (text) {
          this.transcript.push({ role: "user", text });
          this.events.onTranscript("user", text);
        }
        break;
      }
      case "response.output_audio_transcript.done": {
        const text = String(event.transcript ?? "").trim();
        if (text) {
          this.transcript.push({ role: "assistant", text });
          this.events.onTranscript("assistant", text);
        }
        break;
      }
      case "response.function_call_arguments.done": {
        const callId = String(event.call_id ?? "");
        let output = JSON.stringify({ error: "Lookup failed" });
        try {
          const result = await this.client.realtimeTool(this.session!.voiceSessionId, String(event.name ?? ""), String(event.arguments ?? "{}"));
          output = result.output;
          if (result.citations.length) this.events.onCitations?.(result.citations);
        } catch {
          /* tell the model the lookup failed */
        }
        this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
        this.send({ type: "response.create" });
        break;
      }
      case "error":
        console.warn("[ai-chatbot] realtime error", event.error);
        break;
    }
  }

  async end(failed = false, detail?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.dc?.close();
    this.pc?.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.audio) this.audio.srcObject = null;
    this.events.onStatus(failed ? "dropped" : "ended", detail);
    if (this.session) await this.client.endRealtime(this.session.voiceSessionId, this.transcript.slice(-200), failed);
  }
}
