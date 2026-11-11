"use client";

import { useRef, useState, type FormEvent } from "react";

interface Failure {
  provider: string;
  model: string;
  error: string;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  meta?: string;
  error?: string;
  failures?: Failure[];
  streaming?: boolean;
}

/** Parses a text/event-stream body into (event, data) pairs. */
async function* readSse(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) yield { event, data: JSON.parse(data) as Record<string, unknown> };
    }
  }
}

export function Playground({ chatbotId, welcomeMessage }: { chatbotId: string; welcomeMessage: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const updateLast = (fn: (t: Turn) => Turn) => setTurns((ts) => [...ts.slice(0, -1), fn(ts.at(-1)!)]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setTurns((ts) => [...ts, { role: "user", text: message }, { role: "assistant", text: "", streaming: true }]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`/api/v1/chatbots/${chatbotId}/playground`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sessionId }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        updateLast((t) => ({ ...t, streaming: false, error: body.error ?? `Request failed (${res.status})` }));
        return;
      }
      for await (const { event: name, data } of readSse(res.body)) {
        if (name === "session") setSessionId(data.sessionId as string);
        else if (name === "token") updateLast((t) => ({ ...t, text: t.text + (data.text as string) }));
        else if (name === "done") {
          const usage = data.usage as { inputTokens: number; outputTokens: number } | null;
          const failures = data.failedAttempts as Failure[];
          const parts = [
            `${data.provider} / ${data.model}`,
            usage ? `${usage.inputTokens} in · ${usage.outputTokens} out tokens` : "usage not reported",
            `${((data.latencyMs as number) / 1000).toFixed(1)}s`,
          ];
          updateLast((t) => ({ ...t, streaming: false, meta: parts.join(" · "), failures: failures.length ? failures : undefined }));
        } else if (name === "error") {
          updateLast((t) => ({
            ...t,
            streaming: false,
            error: data.message as string,
            failures: (data.failedAttempts as Failure[] | undefined)?.length ? (data.failedAttempts as Failure[]) : undefined,
          }));
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") updateLast((t) => ({ ...t, streaming: false, error: "Connection lost." }));
      else updateLast((t) => ({ ...t, streaming: false, error: "Stopped." }));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function reset() {
    abortRef.current?.abort();
    setTurns([]);
    setSessionId(undefined);
  }

  return (
    <div className="flex flex-col gap-3">
      <div aria-live="polite" className="flex max-h-[28rem] min-h-40 flex-col gap-3 overflow-y-auto rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        {welcomeMessage && (
          <div className="max-w-[85%] self-start rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">{welcomeMessage}</div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`flex max-w-[85%] flex-col gap-1 ${t.role === "user" ? "self-end items-end" : "self-start"}`}>
            {(t.text || t.streaming) && (
              <div
                className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  t.role === "user" ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "bg-zinc-100 dark:bg-zinc-900"
                }`}
              >
                {t.text || <span className="text-zinc-400">…</span>}
              </div>
            )}
            {t.meta && <span className="text-xs text-zinc-500">{t.meta}</span>}
            {t.error && (
              <span role="alert" className="text-xs text-red-600">
                {t.error}
              </span>
            )}
            {t.failures && (
              <ul className="text-xs text-amber-700 dark:text-amber-500">
                {t.failures.map((f, j) => (
                  <li key={j}>
                    {f.provider} / {f.model} failed: {f.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      <form onSubmit={send} className="flex gap-2">
        <label htmlFor="playground-input" className="sr-only">
          Message
        </label>
        <input
          id="playground-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={4000}
          placeholder="Ask your chatbot something"
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
        />
        {busy ? (
          <button type="button" onClick={() => abortRef.current?.abort()} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">
            Stop
          </button>
        ) : (
          <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900" disabled={!input.trim()}>
            Send
          </button>
        )}
        <button type="button" onClick={reset} className="rounded-md px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900">
          New chat
        </button>
      </form>
    </div>
  );
}
