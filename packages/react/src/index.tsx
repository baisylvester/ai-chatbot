/**
 * React / Next.js wrapper. It loads the platform's embed.js once and renders the <ai-chatbot> element;
 * the chat itself is the same framework-independent widget used everywhere else.
 *
 *   <AIChatbot chatbotId="cb_…" apiUrl="https://platform.example" position="bottom-right" />
 *
 * In Next.js App Router, render it from a Client Component ("use client").
 */
import { createElement, useEffect, useState } from "react";

export interface AIChatbotProps {
  chatbotId: string;
  /** Platform URL, e.g. https://chat.example.com (embed.js is loaded from here). */
  apiUrl: string;
  position?: "bottom-right" | "bottom-left";
  theme?: "light" | "dark" | "auto";
  /** Render inside the page flow instead of a floating launcher. */
  mode?: "floating" | "inline";
  open?: boolean;
}

const loading = new Map<string, Promise<void>>();

/** Loads `${apiUrl}/embed.js` once per page. Resolves when <ai-chatbot> is defined. */
export function loadEmbedScript(apiUrl: string): Promise<void> {
  const src = `${apiUrl.replace(/\/+$/, "")}/embed.js`;
  if (typeof window === "undefined") return Promise.resolve();
  if (customElements.get("ai-chatbot")) return Promise.resolve();
  let p = loading.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        loading.delete(src);
        reject(new Error(`Could not load ${src}`));
      };
      document.head.append(script);
    });
    loading.set(src, p);
  }
  return p;
}

export function AIChatbot({ chatbotId, apiUrl, position, theme, mode, open }: AIChatbotProps) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    loadEmbedScript(apiUrl)
      .then(() => active && setReady(true))
      .catch((err: Error) => console.warn(`[ai-chatbot] ${err.message}`));
    return () => {
      active = false;
    };
  }, [apiUrl]);

  if (!ready) return null;
  // `key` remounts the element when the chatbot changes, so it reconnects cleanly.
  return createElement("ai-chatbot", {
    key: `${apiUrl}|${chatbotId}`,
    "chatbot-id": chatbotId,
    "api-url": apiUrl,
    position,
    theme,
    mode,
    open: open ? "" : undefined,
  });
}
