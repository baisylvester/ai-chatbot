"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ClientApiError, SyncedChatClient, type ClientConversation, type ClientMessage } from "@chatbot/client-sdk";

export function SyncedChat({ chatbotId, userId, emailManager = false, suggestions = [], placeholder = "Ask the assistant something" }: {
  chatbotId: string; userId: string; emailManager?: boolean; suggestions?: string[]; placeholder?: string;
}) {
  const client = useMemo(() => new SyncedChatClient({ apiUrl: "", expectedUserId: userId }), [userId]);
  const router = useRouter();
  const formId = useId();
  const selectionKey = `chat-conversation:${userId}:${chatbotId}`;
  const [conversations, setConversations] = useState<ClientConversation[]>([]);
  const [more, setMore] = useState<string | null>(null);
  const [listPages, setListPages] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ClientMessage[]>([]);
  const [last, setLast] = useState<ClientConversation | null>(null);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState("");
  const [activity, setActivity] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const sending = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const pending = useRef<{ conversationId: string; requestId: string; message: string } | null>(null);
  const creating = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; abort.current?.abort(); }; }, []);
  const report = useCallback((err: unknown) => {
    if (err instanceof ClientApiError && err.status === 401) {
      setMessages([]); setConversations([]); setSelected(null); setLast(null); setDraft("");
      abort.current?.abort(); router.refresh();
    }
    setError(err instanceof Error ? err.message : "Could not sync the conversation");
  }, [router]);

  const choose = useCallback((id: string | null) => {
    setSelected(id); setMessages([]); setLast(null); setError(null); setDraft(""); setActivity([]);
    pending.current = null;
    try { if (id) localStorage.setItem(selectionKey, id); else localStorage.removeItem(selectionKey); } catch { /* optional selection memory */ }
  }, [selectionKey]);

  // Re-fetch the list, including removals, on foregrounding and while visible. Older pages
  // remain available through Load older conversations, rather than polling every transcript.
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let initial = true;
    const controller = new AbortController();
    async function refresh() {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        let page = await client.listConversations(chatbotId, undefined, controller.signal);
        const snapshot = [...page.conversations];
        for (let n = 1; n < listPages && page.nextCursor; n++) {
          page = await client.listConversations(chatbotId, page.nextCursor, controller.signal);
          snapshot.push(...page.conversations);
        }
        if (!active) return;
        setConversations(snapshot); setMore(page.nextCursor);
        if (initial) {
          let saved: string | null = null;
          try { saved = localStorage.getItem(selectionKey); } catch { /* unavailable */ }
          // A saved conversation may be on an older page; its owner will be verified on fetch.
          setSelected(saved ?? snapshot[0]?.id ?? null);
          initial = false;
        }
      } catch (err) { if (active) report(err); }
      finally { inFlight = false; if (active) setLoading(false); }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; controller.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [client, chatbotId, selectionKey, report, listPages]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    let inFlight = false;
    let cursor = "0";
    const cached = new Map<string, ClientMessage>();
    const controller = new AbortController();
    async function refresh() {
      if (document.hidden || inFlight || sending.current) return;
      inFlight = true;
      try {
        for (;;) {
          const page = await client.messages(selected!, cursor, controller.signal);
          if (!active) return;
          for (const message of page.messages) cached.set(message.id, message);
          cursor = page.nextCursor;
          const turn = page.conversation.lastTurn;
          // A failed reply may not add an assistant message, so also reconcile prior user status.
          if (turn && turn.status !== "running") for (const [id, message] of cached) {
            if (message.requestId === turn.requestId) cached.set(id, { ...message, status: turn.status });
          }
          setMessages([...cached.values()]); setLast(page.conversation);
          if (!page.hasMore) break;
        }
      } catch (err) {
        if (!active) return;
        if (err instanceof ClientApiError && err.status === 404) {
          choose(null); setError("This conversation was removed or is no longer available.");
        } else report(err);
      } finally { inFlight = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { active = false; controller.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [client, selected, choose, retry, report]);

  async function newConversation() {
    const id = creating.current ?? crypto.randomUUID();
    creating.current = id;
    const conversation = await client.createConversation(chatbotId, id);
    creating.current = null;
    if (alive.current) { setConversations(list => [conversation, ...list.filter(item => item.id !== id)]); choose(id); }
    return id;
  }
  async function send(raw: string) {
    const text = raw.trim();
    if (!text || sending.current) return;
    sending.current = true; setBusy(true); setError(null); setDraft(""); setActivity([]);
    const controller = new AbortController(); abort.current = controller;
    try {
      const id = selected ?? await newConversation();
      const request = pending.current?.conversationId === id && pending.current.message === text
        ? pending.current : { conversationId: id, requestId: crypto.randomUUID(), message: text };
      pending.current = request;
      const turn = await client.send(id, { requestId: request.requestId, message: text, emailManager }, event => {
        if (!alive.current) return;
        if (event.type === "token") setDraft(value => value + event.text);
        if (event.type === "tool" && event.phase === "end") {
          setActivity(items => [...items, ...(event.steps ?? [])]);
          if (event.waiting) router.refresh();
        }
      }, controller.signal);
      if (!alive.current) return;
      pending.current = null; setInput(""); setError(turn.error);
      if (emailManager) router.refresh();
    } catch (err) {
      if (alive.current) report(err);
    } finally {
      sending.current = false; abort.current = null;
      if (alive.current) { setBusy(false); setDraft(""); setRetry(value => value + 1); }
    }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void send(input); };
  const running = last?.lastTurn?.status === "running";
  const button = "rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-zinc-700";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${formId}-conversation`} className="sr-only">Conversation</label>
        <select id={`${formId}-conversation`} value={selected ?? ""} disabled={busy || loading} onChange={event => choose(event.target.value || null)} className={`${button} max-w-full flex-1 bg-transparent`}>
          <option value="">New conversation</option>
          {selected && !conversations.some(item => item.id === selected) && <option value={selected}>Current conversation</option>}
          {conversations.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <button className={button} disabled={busy || loading} onClick={() => void newConversation().catch(err => setError(err.message))}>New chat</button>
        {selected && <button className={button} disabled={busy} onClick={() => void client.deleteConversation(selected).then(() => { setConversations(list => list.filter(item => item.id !== selected)); choose(null); }).catch(err => setError(err.message))}>Delete chat</button>}
      </div>
      {more && <button className={`${button} self-start`} onClick={() => setListPages(count => count + 1)}>Load older conversations</button>}
      <p className="text-xs text-zinc-500">Private to your account. Conversations sync across your signed-in devices.</p>
      <div role="log" aria-label="Conversation messages" aria-live="polite" className="flex max-h-[60vh] min-h-40 flex-col gap-3 overflow-y-auto rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        {messages.map(message => <div key={message.id} className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${message.role === "user" ? "self-end bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "self-start bg-zinc-100 dark:bg-zinc-900"}`}>
          {message.text}
          {message.citations.length > 0 && <details className="mt-2 text-xs"><summary>Sources ({message.citations.length})</summary>{message.citations.map(citation => <p key={citation.n}>[{citation.n}] {citation.title}: {citation.snippet}</p>)}</details>}
        </div>)}
        {!messages.length && !loading && suggestions.map(suggestion => <button className={`${button} self-start text-left`} disabled={busy || running} key={suggestion} onClick={() => void send(suggestion)}>{suggestion}</button>)}
        {busy && <p role="status" className="whitespace-pre-wrap text-sm">{draft || "Working…"}</p>}
        {!busy && running && <p role="status" className="text-sm text-zinc-500">A reply is running. This conversation will update when it is saved.</p>}
        {activity.map((item, index) => <p key={index} className="text-xs text-zinc-500">{item}</p>)}
      </div>
      {(error || (!busy && last?.lastTurn?.error)) && <p role="alert" className="text-sm text-red-600">{error ?? last?.lastTurn?.error}</p>}
      <form onSubmit={submit} className="flex items-end gap-2">
        <label htmlFor={`${formId}-message`} className="sr-only">Message</label>
        <textarea id={`${formId}-message`} value={input} onChange={event => setInput(event.target.value)} rows={2} maxLength={4000} placeholder={placeholder} disabled={busy}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent p-2 text-sm dark:border-zinc-700" />
        <button className={button} disabled={!input.trim() || busy || running || loading} type="submit">Send</button>
      </form>
    </div>
  );
}
