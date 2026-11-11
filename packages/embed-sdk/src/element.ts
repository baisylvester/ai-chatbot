/**
 * <ai-chatbot> custom element. Everything renders inside a Shadow DOM, so host-page CSS can't restyle
 * it and its styles can't affect the host. All text is inserted with textContent (never innerHTML),
 * so chatbot replies or knowledge snippets can't inject markup into the page.
 *
 * Attributes: chatbot-id (required), api-url, theme (light|dark|auto), position (bottom-right|bottom-left),
 * mode (floating|inline), open (start opened).
 */
import { ChatClient, type Citation, type PublicConfig, type StoredMessage } from "./client.ts";
import { styles } from "./styles.ts";

const chatIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/></svg>';
const closeIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown> = {}, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("aria-") || k === "role" || k.startsWith("data-")) node.setAttribute(k, String(v));
    else (node as unknown as Record<string, unknown>)[k] = v;
  }
  node.append(...children);
  return node;
}

const safeHref = (url: string | null) => {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
};

export class AIChatbotElement extends HTMLElement {
  static get observedAttributes() {
    return ["theme"];
  }

  private client: ChatClient | null = null;
  private config: PublicConfig | null = null;
  private messages: StoredMessage[] = [];
  private busy = false;
  private abort: AbortController | null = null;
  private shadow: ShadowRoot;
  private ui: {
    root: HTMLDivElement;
    panel: HTMLDivElement;
    log: HTMLDivElement;
    input: HTMLTextAreaElement;
    send: HTMLButtonElement;
    launcher: HTMLButtonElement | null;
    suggestions: HTMLDivElement;
    title: HTMLHeadingElement;
    status: HTMLDivElement;
  } | null = null;
  private mediaQuery: MediaQueryList | null = null;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
  }

  get inline() {
    return this.getAttribute("mode") === "inline";
  }

  connectedCallback() {
    if (this.ui) return;
    const chatbotId = this.getAttribute("chatbot-id");
    const apiUrl = this.getAttribute("api-url") || defaultApiUrl();
    if (!chatbotId || !apiUrl) {
      console.warn("[ai-chatbot] chatbot-id and api-url are required");
      return;
    }
    this.client = new ChatClient({ apiUrl, chatbotId });
    this.render();
    this.applyTheme();
    this.client
      .loadConfig()
      .then((config) => {
        this.config = config;
        this.ui!.title.textContent = config.name;
        if (!this.getAttribute("position")) this.ui!.root.className = this.rootClass(config.position);
        if (!this.getAttribute("theme")) this.applyTheme();
        this.messages = this.client!.history();
        this.renderMessages();
        if (this.hasAttribute("open") || this.inline) this.open();
      })
      .catch((err: Error) => {
        // Fail quietly on the host page: the widget simply doesn't appear.
        console.warn(`[ai-chatbot] not loaded: ${err.message}`);
        this.ui!.root.hidden = true;
      });
  }

  disconnectedCallback() {
    this.abort?.abort();
    this.mediaQuery?.removeEventListener("change", this.onSchemeChange);
  }

  attributeChangedCallback() {
    if (this.ui) this.applyTheme();
  }

  private onSchemeChange = () => this.applyTheme();

  private applyTheme() {
    const theme = this.getAttribute("theme") || this.config?.theme || "auto";
    if (!this.mediaQuery && typeof window.matchMedia === "function") {
      this.mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      this.mediaQuery.addEventListener("change", this.onSchemeChange);
    }
    const dark = theme === "dark" || (theme === "auto" && !!this.mediaQuery?.matches);
    this.setAttribute("data-theme", dark ? "dark" : "light");
  }

  private rootClass(position: string | null | undefined) {
    if (this.inline) return "root inline";
    return `root ${position === "bottom-left" ? "left" : "right"}`;
  }

  private render() {
    const style = el("style");
    style.textContent = styles;

    const title = el("h2", { id: "aic-title" }, "Chat");
    const newChat = el("button", { className: "icon-btn", type: "button", title: "Start a new conversation" }, "New chat");
    newChat.addEventListener("click", () => this.newConversation());
    const headerButtons = el("div", {}, newChat);
    if (!this.inline) {
      const close = el("button", { className: "icon-btn", type: "button", "aria-label": "Close chat" });
      close.innerHTML = closeIcon; // static, trusted SVG
      close.querySelector("svg")!.setAttribute("width", "16");
      close.addEventListener("click", () => this.close());
      headerButtons.append(close);
    }
    const header = el("header", {}, title, headerButtons);

    const log = el("div", { className: "log", role: "log", "aria-live": "polite", "aria-relevant": "additions" });
    const suggestions = el("div", { className: "suggestions" });
    const input = el("textarea", { rows: 1, maxLength: 4000, placeholder: "Type your message…" });
    const label = el("label", { className: "sr", htmlFor: "aic-input" }, "Message");
    input.id = "aic-input";
    const send = el("button", { className: "send", type: "submit" }, "Send");
    const form = el("form", {}, label, input, send);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.submit(input.value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.submit(input.value);
      }
    });
    const status = el("div", { className: "sr", role: "status" });
    const footer = el("div", { className: "footer" }, "AI responses may be inaccurate.");

    const panel = el("div", { className: "panel", role: "dialog", "aria-labelledby": "aic-title" }, header, log, suggestions, form, footer, status);
    panel.hidden = !this.inline;
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.inline) this.close();
    });

    const root = el("div", { className: this.rootClass(this.getAttribute("position")) }, panel);
    let launcher: HTMLButtonElement | null = null;
    if (!this.inline) {
      launcher = el("button", { className: "launcher", type: "button", "aria-label": "Open chat", "aria-expanded": "false" });
      launcher.innerHTML = chatIcon; // static, trusted SVG
      launcher.addEventListener("click", () => (panel.hidden ? this.open() : this.close()));
      root.append(launcher);
    }
    this.shadow.replaceChildren(style, root);
    this.ui = { root, panel, log, input, send, launcher, suggestions, title, status };
  }

  open() {
    if (!this.ui) return;
    this.ui.panel.hidden = false;
    this.ui.launcher?.setAttribute("aria-expanded", "true");
    this.ui.launcher?.setAttribute("aria-label", "Close chat");
    this.ui.input.focus();
    this.dispatchEvent(new CustomEvent("ai-chatbot:open", { bubbles: true, composed: true }));
  }

  close() {
    if (!this.ui || this.inline) return;
    this.ui.panel.hidden = true;
    this.ui.launcher?.setAttribute("aria-expanded", "false");
    this.ui.launcher?.setAttribute("aria-label", "Open chat");
    this.ui.launcher?.focus();
    this.dispatchEvent(new CustomEvent("ai-chatbot:close", { bubbles: true, composed: true }));
  }

  private newConversation() {
    this.abort?.abort();
    this.client?.reset();
    this.messages = [];
    this.renderMessages();
    this.ui?.input.focus();
  }

  private renderSources(citations: Citation[]) {
    const list = el("ol");
    for (const c of citations) {
      const href = safeHref(c.sourceUrl);
      const titleNode = href ? el("a", { href, target: "_blank", rel: "noopener noreferrer" }, c.title) : document.createTextNode(c.title);
      list.append(el("li", { title: c.snippet }, titleNode));
    }
    return el("details", { className: "sources" }, el("summary", {}, `Sources (${citations.length})`), list);
  }

  private renderMessages() {
    const ui = this.ui;
    if (!ui) return;
    const nodes: Node[] = [];
    if (this.config?.welcomeMessage) nodes.push(el("div", { className: "msg assistant" }, this.config.welcomeMessage));
    for (const m of this.messages) {
      if (m.text) nodes.push(el("div", { className: `msg ${m.role}` }, m.text));
      if (m.citations?.length) nodes.push(this.renderSources(m.citations));
      if (m.error) nodes.push(el("div", { className: "msg error", role: "alert" }, m.error));
    }
    ui.log.replaceChildren(...nodes);
    ui.log.scrollTop = ui.log.scrollHeight;

    const showSuggestions = this.messages.length === 0 && (this.config?.suggestedQuestions.length ?? 0) > 0;
    ui.suggestions.replaceChildren(
      ...(showSuggestions
        ? this.config!.suggestedQuestions.map((q) => {
            const chip = el("button", { className: "chip", type: "button" }, q);
            chip.addEventListener("click", () => void this.submit(q));
            return chip;
          })
        : []),
    );
    ui.send.disabled = this.busy;
    ui.send.textContent = this.busy ? "…" : "Send";
  }

  private async submit(raw: string) {
    const text = raw.trim();
    if (!text || this.busy || !this.client || !this.ui) return;
    this.ui.input.value = "";
    this.busy = true;
    this.messages.push({ role: "user", text });
    const reply: StoredMessage = { role: "assistant", text: "" };
    this.messages.push(reply);
    this.renderMessages();
    const typing = el("div", { className: "msg assistant typing" }, "…");
    this.ui.log.append(typing);
    this.ui.status.textContent = "Assistant is typing";
    this.abort = new AbortController();

    let pending = false;
    const flush = () => {
      pending = false;
      this.renderMessages();
    };
    await this.client.send(
      text,
      {
        onSources: (citations) => {
          reply.citations = citations;
        },
        onToken: (t) => {
          reply.text += t;
          if (!pending) {
            pending = true;
            requestAnimationFrame(flush);
          }
        },
        onDone: () => undefined,
        onError: (message) => {
          reply.error = message;
        },
      },
      this.abort.signal,
    );
    this.busy = false;
    this.abort = null;
    if (!reply.text && !reply.error) reply.error = "No reply was received.";
    this.client.saveHistory(this.messages.filter((m) => m.text));
    this.renderMessages();
    this.ui.status.textContent = "Reply received";
  }
}

/** api-url defaults to the origin that served embed.js. */
export function defaultApiUrl(): string | null {
  return scriptOrigin;
}

let scriptOrigin: string | null = null;
try {
  const current = document.currentScript as HTMLScriptElement | null;
  if (current?.src) scriptOrigin = new URL(current.src).origin;
} catch {
  /* ignore */
}
