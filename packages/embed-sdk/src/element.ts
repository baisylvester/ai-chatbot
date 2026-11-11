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
import { micErrorMessage, RealtimeCall, Recorder, Speaker, voiceSupported, type CallStatus } from "./voice.ts";

const chatIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/></svg>';
const micIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
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
    form: HTMLFormElement;
    headerButtons: HTMLDivElement;
    callStatus: HTMLSpanElement;
  } | null = null;
  private recorder: Recorder | null = null;
  private speaker = new Speaker();
  private speakerOn = false;
  private call: RealtimeCall | null = null;
  private pendingCitations: Citation[] | undefined;
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
        this.setupVoice(config);
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
    this.speaker.stop();
    this.recorder?.cancel();
    void this.call?.end();
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
    const callStatus = el("span", { className: "call-status", role: "status" });
    const header = el("header", {}, el("div", { className: "title" }, title, callStatus), headerButtons);

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
    this.ui = { root, panel, log, input, send, launcher, suggestions, title, status, form, headerButtons, callStatus };
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
    this.speaker.stop();
    this.recorder?.cancel();
    this.recorder = null;
    void this.call?.end();
    this.ui.panel.hidden = true;
    this.ui.launcher?.setAttribute("aria-expanded", "false");
    this.ui.launcher?.setAttribute("aria-label", "Open chat");
    this.ui.launcher?.focus();
    this.dispatchEvent(new CustomEvent("ai-chatbot:close", { bubbles: true, composed: true }));
  }

  private newConversation() {
    this.abort?.abort();
    this.speaker.stop();
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
    this.speaker.stop();
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
    if (this.speakerOn && reply.text && !reply.error) {
      this.speaker.play(this.client, reply.text).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- voice

  private setupVoice(config: PublicConfig) {
    const ui = this.ui;
    const mode = config.voice?.mode ?? "off";
    if (!ui || mode === "off") return;

    if (mode === "standard" && voiceSupported.record()) {
      this.speakerOn = !!config.voice?.autoSpeak;
      const mic = el("button", { className: "mic", type: "button", "aria-label": "Speak your message", "aria-pressed": "false", title: "Tap to talk, tap again to send" });
      mic.innerHTML = micIcon; // static, trusted SVG
      mic.addEventListener("click", () => void this.toggleRecording(mic));
      ui.form.insertBefore(mic, ui.send);

      const sound = el("button", { className: "icon-btn", type: "button" });
      const label = () => {
        sound.textContent = this.speakerOn ? "Sound on" : "Sound off";
        sound.setAttribute("aria-pressed", String(this.speakerOn));
        sound.title = this.speakerOn ? "Replies are read aloud. Click to mute." : "Click to have replies read aloud.";
      };
      label();
      sound.addEventListener("click", () => {
        this.speakerOn = !this.speakerOn;
        if (!this.speakerOn) this.speaker.stop();
        label();
      });
      ui.headerButtons.prepend(sound);
    }

    if (mode === "realtime" && voiceSupported.realtime()) {
      const callBtn = el("button", { className: "icon-btn call", type: "button", "aria-pressed": "false" }, "Voice call");
      callBtn.addEventListener("click", () => void this.toggleCall(callBtn));
      ui.headerButtons.prepend(callBtn);
    }
  }

  /** Shows a short notice in the conversation (not saved to history). */
  private notice(message: string) {
    this.messages.push({ role: "assistant", text: "", error: message });
    this.renderMessages();
  }

  private async toggleRecording(mic: HTMLButtonElement) {
    const ui = this.ui;
    if (!this.client || !ui || this.busy) return;
    if (!this.recorder?.recording) {
      this.speaker.stop();
      this.recorder = new Recorder();
      try {
        await this.recorder.start();
      } catch (err) {
        this.recorder = null;
        this.notice(micErrorMessage(err));
        return;
      }
      mic.setAttribute("aria-pressed", "true");
      mic.classList.add("recording");
      ui.status.textContent = "Recording";
      ui.input.placeholder = "Listening… tap the mic again to send";
      return;
    }
    const { blob, durationMs } = await this.recorder.stop();
    this.recorder = null;
    mic.setAttribute("aria-pressed", "false");
    mic.classList.remove("recording");
    if (durationMs < 400 || blob.size === 0) {
      ui.input.placeholder = "Type your message…";
      this.notice("That was too short. Tap the mic and speak.");
      return;
    }
    ui.input.placeholder = "Transcribing…";
    try {
      const text = await this.client.transcribe(blob, durationMs);
      ui.input.placeholder = "Type your message…";
      if (text) await this.submit(text);
      else this.notice("I didn't catch that. Please try again.");
    } catch (err) {
      ui.input.placeholder = "Type your message…";
      this.notice((err as Error).message || "Voice isn't available right now.");
    }
  }

  private async toggleCall(btn: HTMLButtonElement) {
    const ui = this.ui;
    if (!this.client || !ui) return;
    if (this.call) {
      btn.disabled = true;
      await this.call.end();
      return;
    }
    this.speaker.stop();
    const labels: Record<CallStatus, string> = { connecting: "Connecting…", listening: "Listening", speaking: "Speaking", ended: "", dropped: "" };
    const call = new RealtimeCall(this.client, {
      onStatus: (status, detail) => {
        ui.callStatus.textContent = labels[status];
        if (status === "ended" || status === "dropped") {
          this.call = null;
          btn.textContent = "Voice call";
          btn.disabled = false;
          btn.setAttribute("aria-pressed", "false");
          if (status === "dropped") this.notice(detail ?? "The call ended unexpectedly. Start it again to reconnect.");
          this.client?.saveHistory(this.messages.filter((m) => m.text));
        }
      },
      onTranscript: (role, text) => {
        this.messages.push({ role, text, citations: role === "assistant" ? this.pendingCitations : undefined });
        if (role === "assistant") this.pendingCitations = undefined;
        this.renderMessages();
      },
      onCitations: (citations) => {
        this.pendingCitations = citations;
      },
    });
    this.call = call;
    btn.textContent = "End call";
    btn.setAttribute("aria-pressed", "true");
    try {
      await call.start();
    } catch (err) {
      const name = (err as { name?: string }).name;
      const message =
        name === "NotAllowedError" || name === "NotFoundError" || name === "SecurityError"
          ? micErrorMessage(err)
          : (err as Error).message || "The voice call couldn't start.";
      await call.end(true, message);
    }
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
