import "server-only";
import type { VoiceSettings } from "@chatbot/shared";
import { listVoiceProviders, realtimeVoices } from "@chatbot/voice-engine";

const selectClass = "rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700";
const labels: Record<string, string> = { openai: "OpenAI", elevenlabs: "ElevenLabs", mock: "Mock (development)" };

/** Voice fields for the chatbot settings form. Shows which voice providers have server credentials. */
export function VoiceSettingsFields({ voice }: { voice: VoiceSettings }) {
  const providers = listVoiceProviders(process.env);
  const option = (p: (typeof providers)[number]) => (
    <option key={p.id} value={p.id}>
      {labels[p.id] ?? p.id}
      {p.configured ? "" : " (not configured)"}
    </option>
  );
  const openaiReady = providers.find((p) => p.id === "openai")?.configured;
  return (
    <fieldset className="grid gap-4 rounded-lg border border-zinc-200 p-3 sm:col-span-2 sm:grid-cols-2 dark:border-zinc-800">
      <legend className="px-1 text-sm font-medium">Voice</legend>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">
        <span className="font-medium">Voice mode</span>
        <select name="voiceMode" defaultValue={voice.mode} className={selectClass}>
          <option value="off">Off (text only)</option>
          <option value="standard">Standard: tap to talk, replies read aloud (uses knowledge and citations)</option>
          <option value="realtime">Realtime: live voice call (OpenAI Realtime{openaiReady ? "" : ", not configured"})</option>
        </select>
      </label>
      {voice.mode === "realtime" && (
        <p role="note" className="rounded-md border border-amber-300 p-2 text-xs sm:col-span-2 dark:border-amber-700">
          ⚠ In realtime mode the visitor&apos;s browser connects to OpenAI directly and can see this chatbot&apos;s system prompt.
          Don&apos;t put secrets in it. Calls are limited to one per conversation and a daily budget per organization
          (REALTIME_DAILY_MINUTES, default 120).
        </p>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Speech-to-text</span>
        <select name="sttProvider" defaultValue={voice.sttProvider} className={selectClass}>
          {providers.filter((p) => p.capabilities.stt).map(option)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Text-to-speech</span>
        <select name="ttsProvider" defaultValue={voice.ttsProvider} className={selectClass}>
          {providers.filter((p) => p.capabilities.tts).map(option)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Reading voice</span>
        <input name="ttsVoice" defaultValue={voice.ttsVoice} className={selectClass} required />
        <span className="text-xs text-zinc-500">OpenAI: alloy, coral, nova, sage… · ElevenLabs: a voice ID</span>
      </label>
      <label className="flex items-center gap-2 self-end text-sm">
        <input type="checkbox" name="autoSpeak" defaultChecked={voice.autoSpeak} />
        Read replies aloud by default
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Realtime model</span>
        <input name="realtimeModel" defaultValue={voice.realtimeModel} className={selectClass} required />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Realtime voice</span>
        <select name="realtimeVoice" defaultValue={voice.realtimeVoice} className={selectClass}>
          {realtimeVoices().map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}
