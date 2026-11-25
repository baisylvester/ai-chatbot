"use client";

import { useEffect, useId, useState } from "react";
import { SyncedChat } from "@/components/synced-chat";

export interface AssistantChatbot { id: string; publicId: string; name: string; organization: string }

const STORAGE_KEY = "assistant-chatbot";
const MAIL_SUGGESTIONS = ["What's new in my inbox today?", "Which emails need a reply from me?", "Summarize unread mail from this week"];

/**
 * The Assistant's chat: one of the user's chatbots answers, and when their mailbox is connected the
 * same chat also works in their Gmail. With several chatbots the user picks which one answers.
 */
export function AssistantChat({ chatbots, mailbox, userId }: { chatbots: AssistantChatbot[]; mailbox: boolean; userId: string }) {
  const id = useId();
  const [chatbotId, setChatbotId] = useState(chatbots[0]!.id);

  // Remember the last chatbot on this device. The page renders correctly without it.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(`${STORAGE_KEY}:${userId}`);
      if (saved && chatbots.some((bot) => bot.id === saved)) setChatbotId(saved);
    } catch {
      // Storage can be blocked; the first chatbot stays selected.
    }
  }, [chatbots, userId]);

  function choose(next: string) {
    setChatbotId(next);
    try { window.localStorage.setItem(`${STORAGE_KEY}:${userId}`, next); } catch { /* not remembered */ }
  }

  return (
    <div className="flex flex-col gap-3">
      {chatbots.length > 1 && (
        <label htmlFor={`${id}-chatbot`} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Answering as</span>
          <select id={`${id}-chatbot`} value={chatbotId} onChange={(event) => choose(event.target.value)}
            className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700">
            {chatbots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name} ({bot.organization})</option>)}
          </select>
        </label>
      )}
      <SyncedChat key={`${userId}:${chatbotId}`} chatbotId={chatbots.find(bot => bot.id === chatbotId)!.publicId} userId={userId} emailManager={mailbox}
        suggestions={mailbox ? MAIL_SUGGESTIONS : []}
        placeholder={mailbox ? "Ask a question, or tell the assistant what to do in your mail" : "Ask the assistant something"} />
    </div>
  );
}
