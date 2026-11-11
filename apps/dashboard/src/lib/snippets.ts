/** Install snippets shown on a chatbot's embed panel. Only public identifiers appear in them. */
export function embedSnippets(opts: { platformUrl: string; chatbotId: string; position: string; theme: string }) {
  const { platformUrl: api, chatbotId: id, position, theme } = opts;
  return {
    script: `<script>
  window.AIChatbotConfig = {
    chatbotId: "${id}",
    apiUrl: "${api}",
    position: "${position}",
    theme: "${theme}"
  };
</script>
<script src="${api}/embed.js" async></script>`,
    webComponent: `<script src="${api}/embed.js" async></script>
<ai-chatbot chatbot-id="${id}" api-url="${api}" theme="${theme}" position="${position}"></ai-chatbot>

<!-- Inline (inside your layout instead of a floating launcher): -->
<ai-chatbot chatbot-id="${id}" api-url="${api}" mode="inline" style="display:block;height:560px"></ai-chatbot>`,
    iframe: `<iframe
  src="${api}/embed/frame?chatbotId=${id}"
  title="Chat"
  style="width:100%;max-width:420px;height:560px;border:0;border-radius:12px"
  allow="microphone; clipboard-write"></iframe>`,
    react: `// npm: copy packages/react from the platform repo, or use the script snippet.
"use client";
import { AIChatbot } from "@chatbot/react";

export function SiteChat() {
  return <AIChatbot chatbotId="${id}" apiUrl="${api}" position="${position}" theme="${theme}" />;
}`,
    rest: `curl ${api}/api/v1/chat \\
  -H "Authorization: Bearer $CHATBOT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"chatbotId":"${id}","message":"Hello"}'
# Server-side only: never put a private API key in browser code.`,
  };
}
