/**
 * AI Chatbot embed. One script, three ways to use it:
 *
 * 1. Script snippet: set window.AIChatbotConfig = { chatbotId, apiUrl?, position?, theme? } and load embed.js.
 * 2. Web Component: load embed.js, then <ai-chatbot chatbot-id="cb_…"></ai-chatbot>.
 * 3. iframe: AIChatbot.mountIframe({ chatbotId, target }) or a plain <iframe src="…/embed/frame?chatbotId=…">.
 *
 * Everything is wrapped so a failure never breaks the host page.
 */
import { AIChatbotElement, defaultApiUrl } from "./element.ts";

export { ChatClient, readSse } from "./client.ts";
export type { Citation, PublicConfig } from "./client.ts";

export const VERSION = "0.1.0";

interface MountOptions {
  chatbotId: string;
  apiUrl?: string;
  position?: "bottom-right" | "bottom-left";
  theme?: "light" | "dark" | "auto";
  open?: boolean;
  /** Element to append to (default: document.body). */
  container?: HTMLElement;
}

function define() {
  if (!customElements.get("ai-chatbot")) customElements.define("ai-chatbot", AIChatbotElement);
}

function mount(opts: MountOptions): HTMLElement | null {
  try {
    define();
    const node = document.createElement("ai-chatbot");
    node.setAttribute("chatbot-id", opts.chatbotId);
    const api = opts.apiUrl || defaultApiUrl();
    if (api) node.setAttribute("api-url", api);
    if (opts.position) node.setAttribute("position", opts.position);
    if (opts.theme) node.setAttribute("theme", opts.theme);
    if (opts.open) node.setAttribute("open", "");
    (opts.container ?? document.body).append(node);
    return node;
  } catch (err) {
    console.warn("[ai-chatbot] could not mount", err);
    return null;
  }
}

/**
 * Embeds the chat in an iframe served by the platform. Messages from the frame are accepted only
 * when they come from that iframe's window and the platform's origin.
 */
function mountIframe(opts: { chatbotId: string; apiUrl?: string; target: HTMLElement; theme?: string; height?: number }): HTMLIFrameElement | null {
  try {
    const api = (opts.apiUrl || defaultApiUrl() || "").replace(/\/+$/, "");
    const platformOrigin = new URL(api).origin;
    const frame = document.createElement("iframe");
    const src = new URL(`${api}/embed/frame`);
    src.searchParams.set("chatbotId", opts.chatbotId);
    if (opts.theme) src.searchParams.set("theme", opts.theme);
    frame.src = src.toString();
    frame.title = "Chat";
    frame.style.cssText = `width:100%;height:${opts.height ?? 560}px;border:0;border-radius:12px;`;
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    frame.setAttribute("allow", "microphone; clipboard-write");
    window.addEventListener("message", (event) => {
      if (event.origin !== platformOrigin || event.source !== frame.contentWindow) return;
      const data = event.data as { source?: string; type?: string; height?: number } | null;
      if (data?.source !== "ai-chatbot") return;
      if (data.type === "resize" && typeof data.height === "number" && data.height > 200 && data.height < 2000) {
        frame.style.height = `${Math.round(data.height)}px`;
      }
      frame.dispatchEvent(new CustomEvent(`ai-chatbot:${data.type}`, { detail: data }));
    });
    opts.target.append(frame);
    return frame;
  } catch (err) {
    console.warn("[ai-chatbot] could not mount iframe", err);
    return null;
  }
}

/** Inside the platform's iframe page: tell the parent (and only the parent's origin) we're ready. */
function notifyParent() {
  try {
    if (window.parent === window || !document.referrer) return;
    const parentOrigin = new URL(document.referrer).origin;
    window.parent.postMessage({ source: "ai-chatbot", type: "ready", version: VERSION }, parentOrigin);
  } catch {
    /* not framed or referrer hidden */
  }
}

try {
  define();
  const w = window as unknown as {
    AIChatbot?: unknown;
    AIChatbotConfig?: MountOptions | MountOptions[];
  };
  w.AIChatbot = { mount, mountIframe, version: VERSION };
  const auto = w.AIChatbotConfig;
  if (auto) {
    const start = () => (Array.isArray(auto) ? auto : [auto]).forEach((cfg) => cfg?.chatbotId && mount(cfg));
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  }
  if (document.querySelector('ai-chatbot[mode="inline"]')) notifyParent();
} catch (err) {
  console.warn("[ai-chatbot] failed to initialise", err);
}
