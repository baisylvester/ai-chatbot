import { notFound } from "next/navigation";
import { loadBot } from "@chatbot/core";
import { SyncedChat } from "@/components/synced-chat";
import { clientTrusted } from "@/lib/client-api";
import { requireUser } from "@/lib/session";

export default async function ChatPage({ params }: { params: Promise<{ chatbotId: string }> }) {
  const user = await requireUser();
  const { chatbotId } = await params;
  const bot = await clientTrusted(db => loadBot(db, "c.public_id = $1", chatbotId));
  if (!bot || bot.status !== "active") notFound();
  return <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-4 p-4 sm:p-8">
    <h1 className="text-2xl font-semibold">{bot.settings.name}</h1>
    <SyncedChat key={`${user.id}:${chatbotId}`} chatbotId={chatbotId} userId={user.id} suggestions={bot.settings.suggestedQuestions} />
    <form action="/auth/sign-in"><button className="text-sm underline">Account</button></form>
  </main>;
}
