"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import type { ChatResult } from "@/app/(platform)/agent/actions";

interface Turn { role: "user" | "assistant"; content: string; steps?: { tool: string; summary: string }[]; failed?: boolean }

const SUGGESTIONS = [
  "What's new in my inbox today?",
  "Which emails need a reply from me?",
  "Summarize unread mail from this week",
  "Archive newsletters I haven't opened",
];

/** Chat with the mail agent. The conversation lives in this tab only; nothing is stored on the server. */
export function MailAgentChat({ action }: { action: (history: unknown) => Promise<ChatResult> }) {
  const id = useId();
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [turns, pending]);

  function send(message: string) {
    const content = message.trim();
    if (!content || pending) return;
    // A failed request is dropped together with the question that caused it, so asking again
    // does not send the model the same question twice.
    const kept = turns.filter((turn, index) => !turn.failed && !turns[index + 1]?.failed);
    const next: Turn[] = [...kept, { role: "user", content }];
    setTurns(next);
    setText("");
    startTransition(async () => {
      let result: ChatResult;
      try {
        result = await action(next.map(({ role, content: body }) => ({ role, content: body })));
      } catch {
        result = { error: "Could not reach the server. Check your connection and try again." };
      }
      if ("error" in result) {
        setTurns((list) => [...list, { role: "assistant", content: result.error, failed: true }]);
        return;
      }
      setTurns((list) => [...list, { role: "assistant", content: result.reply, steps: result.steps }]);
      // Drafts and trash requests show up in "Waiting for your approval" above the chat.
      if (result.queued) router.refresh();
    });
  }

  const submit = (event: FormEvent) => { event.preventDefault(); send(text); };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(text); }
  };

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div role="log" aria-live="polite" aria-label="Conversation" className="max-h-[60vh] min-h-40 space-y-3 overflow-y-auto p-3 sm:p-4">
        {turns.length === 0 && (
          <div>
            <p className="text-sm text-zinc-500">Ask about your mail, or start with one of these:</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => send(suggestion)} disabled={pending}
                  className="rounded-full border border-zinc-300 px-3 py-1.5 text-left text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((turn, index) => (
          <div key={index} className={turn.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div className={`max-w-[88%] rounded-2xl px-3.5 py-2 text-sm ${
              turn.role === "user" ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
                : turn.failed ? "border border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                  : "bg-zinc-100 dark:bg-zinc-900"}`}>
              {turn.steps && turn.steps.length > 0 && (
                <ul className="mb-2 space-y-0.5 border-b border-zinc-200 pb-2 text-xs text-zinc-500 dark:border-zinc-800">
                  {turn.steps.map((step, stepIndex) => <li key={stepIndex}>✓ {step.summary}</li>)}
                </ul>
              )}
              <p className="whitespace-pre-wrap break-words">{turn.content}</p>
            </div>
          </div>
        ))}
        {pending && <p role="status" className="text-sm text-zinc-500">Working in your mailbox…</p>}
        <div ref={endRef} />
      </div>
      <form onSubmit={submit} className="flex items-end gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
        <label htmlFor={`${id}-message`} className="sr-only">Message to the mail agent</label>
        <textarea id={`${id}-message`} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown}
          rows={2} maxLength={4000} placeholder="Ask about your mail, or tell the agent what to do"
          className="min-w-0 flex-1 resize-none rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700" />
        <button type="submit" disabled={pending || !text.trim()}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
          Send
        </button>
      </form>
    </div>
  );
}
