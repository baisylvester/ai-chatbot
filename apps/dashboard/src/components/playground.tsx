"use client";

import { useRef, useState, type FormEvent } from "react";

interface Failure {
  provider: string;
  model: string;
  error: string;
}

interface Citation {
  n: number;
  title: string;
  sourceUrl: string | null;
  snippet: string;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  meta?: string;
  error?: string;
  failures?: Failure[];
  citations?: Citation[];
  streaming?: boolean;
  /** Email manager activity in this reply. */
  mailWorking?: boolean;
  mailSteps?: string[];
  mailWaiting?: number;
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

export function Playground({ chatbotId, welcomeMessage, emailManager = false }: {
  chatbotId: string;
  welcomeMessage: string;
  /** The signed-in user has a connected mailbox, so this chat can offer their email manager. */
  emailManager?: boolean;
}) {
  const [useMail, setUseMail] = useState(emailManager);
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
        body: JSON.stringify({ message, sessionId, ...(emailManager && useMail ? { emailManager: true } : {}) }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        updateLast((t) => ({ ...t, streaming: false, error: body.error ?? `Request failed (${res.status})` }));
        return;
      }
      for await (const { event: name, data } of readSse(res.body)) {
        if (name === "session") setSessionId(data.sessionId as string);
        else if (name === "sources") updateLast((t) => ({ ...t, citations: data.citations as Citation[] }));
        else if (name === "token") updateLast((t) => ({ ...t, text: t.text + (data.text as string) }));
        else if (name === "tool") {
          if (data.phase === "start") updateLast((t) => ({ ...t, mailWorking: true }));
          else updateLast((t) => ({
            ...t,
            mailWorking: false,
            mailSteps: [...(t.mailSteps ?? []), ...((data.steps as string[] | undefined) ?? [])],
            mailWaiting: (t.mailWaiting ?? 0) + ((data.waiting as number | undefined) ?? 0),
          }));
        }
        else if (name === "done") {
          const usage = data.usage as { inputTokens: number; outputTokens: number } | null;
          const failures = data.failedAttempts as Failure[];
          const parts = [
            `${data.provider} / ${data.model}`,
            usage ? `${usage.inputTokens} in · ${usage.outputTokens} out tokens` : "usage not reported",
            `${((data.latencyMs as number) / 1000).toFixed(1)}s`,
          ];
          updateLast((t) => ({ ...t, streaming: false, mailWorking: false, meta: parts.join(" · "), failures: failures.length ? failures : undefined }));
        } else if (name === "error") {
          updateLast((t) => ({
            ...t,
            streaming: false,
            mailWorking: false,
            error: data.message as string,
            failures: (data.failedAttempts as Failure[] | undefined)?.length ? (data.failedAttempts as Failure[]) : undefined,
          }));
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") updateLast((t) => ({ ...t, streaming: false, mailWorking: false, error: "Connection lost." }));
      else updateLast((t) => ({ ...t, streaming: false, mailWorking: false, error: "Stopped." }));
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
      {emailManager && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={useMail} onChange={(e) => setUseMail(e.target.checked)} disabled={busy} className="mt-0.5" />
          <span>
            Email manager: let this chat work in my Gmail
            <span className="block text-xs text-zinc-500">
              Only for you, in this test chat. Website visitors never get mailbox access. Nothing is sent or deleted without your approval on the Mail agent page. Replies are saved under Conversations, where members of this organization can read them.
            </span>
          </span>
        </label>
      )}
      <div aria-live="polite" className="flex max-h-[28rem] min-h-40 flex-col gap-3 overflow-y-auto rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        {welcomeMessage && (
          <div className="max-w-[85%] self-start rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">{welcomeMessage}</div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`flex max-w-[85%] flex-col gap-1 ${t.role === "user" ? "self-end items-end" : "self-start"}`}>
            {t.mailSteps && t.mailSteps.length > 0 && (
              <ul className="space-y-0.5 text-xs text-zinc-500">
                {t.mailSteps.map((step, j) => <li key={j}>✓ {step}</li>)}
              </ul>
            )}
            {t.mailWorking && <span role="status" className="text-xs text-zinc-500">Working in your mailbox…</span>}
            {(t.text || t.streaming) && (
              <div
                className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  t.role === "user" ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "bg-zinc-100 dark:bg-zinc-900"
                }`}
              >
                {t.text || <span className="text-zinc-400">…</span>}
              </div>
            )}
            {t.citations && !t.streaming && (
              <details className="text-xs text-zinc-600 dark:text-zinc-400">
                <summary className="cursor-pointer">
                  {t.citations.length} source{t.citations.length === 1 ? "" : "s"} retrieved
                </summary>
                <ol className="mt-1 space-y-1">
                  {t.citations.map((c) => (
                    <li key={c.n}>
                      <span className="font-medium">
                        [{c.n}]{" "}
                        {c.sourceUrl ? (
                          <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">
                            {c.title}
                          </a>
                        ) : (
                          c.title
                        )}
                      </span>
                      <span className="block text-zinc-500">{c.snippet}</span>
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {!!t.mailWaiting && !t.streaming && (
              <a href="/agent" className="text-xs font-medium underline">
                {t.mailWaiting === 1 ? "1 action is" : `${t.mailWaiting} actions are`} waiting for your approval on the Mail agent page
              </a>
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
