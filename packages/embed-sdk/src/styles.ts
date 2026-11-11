/**
 * Widget styles, scoped inside the Shadow DOM. `:host { all: initial }` stops host-page styles
 * (fonts, colors, box-sizing, resets) from leaking in; nothing here can leak out.
 * Themeable through CSS custom properties set on the element, e.g.
 *   ai-chatbot { --aic-accent: #0f766e; --aic-font: "Inter", sans-serif; }
 */
export const styles = `
:host {
  all: initial;
  --aic-accent: #18181b;
  --aic-accent-text: #ffffff;
  --aic-bg: #ffffff;
  --aic-text: #18181b;
  --aic-muted: #71717a;
  --aic-border: #e4e4e7;
  --aic-bubble: #f4f4f5;
  --aic-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --aic-radius: 16px;
  --aic-width: 380px;
  --aic-height: 560px;
  --aic-z: 2147483000;
  font-family: var(--aic-font);
  color: var(--aic-text);
}
/* Inline mode fills its container (give the container a height). */
:host([mode="inline"]) { display: block; height: 100%; min-height: 360px; }
:host([data-theme="dark"]) {
  --aic-accent: #fafafa;
  --aic-accent-text: #18181b;
  --aic-bg: #18181b;
  --aic-text: #fafafa;
  --aic-muted: #a1a1aa;
  --aic-border: #3f3f46;
  --aic-bubble: #27272a;
}
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--aic-accent); outline-offset: 2px; }

.root { position: fixed; bottom: 20px; z-index: var(--aic-z); font-size: 14px; line-height: 1.45; }
.root.right { right: 20px; }
.root.left { left: 20px; }
.root.inline { position: static; height: 100%; }

.launcher {
  width: 56px; height: 56px; border-radius: 50%; border: 0;
  background: var(--aic-accent); color: var(--aic-accent-text);
  box-shadow: 0 8px 24px rgba(0,0,0,.2); display: grid; place-items: center;
}
.launcher svg { width: 26px; height: 26px; }

.panel {
  position: absolute; bottom: 72px; width: var(--aic-width); height: var(--aic-height);
  max-height: calc(100vh - 110px); background: var(--aic-bg); color: var(--aic-text);
  border: 1px solid var(--aic-border); border-radius: var(--aic-radius);
  box-shadow: 0 16px 48px rgba(0,0,0,.2); display: flex; flex-direction: column; overflow: hidden;
}
.right .panel { right: 0; }
.left .panel { left: 0; }
.inline .panel { position: static; width: 100%; height: 100%; max-height: none; border-radius: 0; box-shadow: none; border: 0; }
.panel[hidden] { display: none; }

header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--aic-border); }
header h2 { margin: 0; font-size: 15px; font-weight: 600; }
.icon-btn { background: transparent; border: 0; color: var(--aic-muted); padding: 4px 6px; border-radius: 8px; font-size: 13px; }
.icon-btn:hover { background: var(--aic-bubble); color: var(--aic-text); }

.log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.msg { max-width: 85%; white-space: pre-wrap; word-wrap: break-word; padding: 8px 12px; border-radius: 14px; }
.msg.assistant { align-self: flex-start; background: var(--aic-bubble); }
.msg.user { align-self: flex-end; background: var(--aic-accent); color: var(--aic-accent-text); }
.msg.error { align-self: flex-start; color: #dc2626; background: transparent; padding: 0 4px; font-size: 13px; }
.typing { color: var(--aic-muted); }
.sources { align-self: flex-start; max-width: 85%; font-size: 12px; color: var(--aic-muted); }
.sources summary { cursor: pointer; }
.sources ol { margin: 4px 0 0; padding-left: 18px; }
.sources a { color: inherit; }

.suggestions { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 10px; }
.chip { border: 1px solid var(--aic-border); background: transparent; color: var(--aic-text); border-radius: 999px; padding: 4px 10px; font-size: 13px; }
.chip:hover { background: var(--aic-bubble); }

form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--aic-border); }
textarea {
  flex: 1; resize: none; font: inherit; color: var(--aic-text); background: transparent;
  border: 1px solid var(--aic-border); border-radius: 10px; padding: 8px 10px; max-height: 120px;
}
.send { border: 0; border-radius: 10px; padding: 0 14px; background: var(--aic-accent); color: var(--aic-accent-text); font-weight: 600; }
.send:disabled { opacity: .5; cursor: default; }
.title { display: flex; flex-direction: column; min-width: 0; }
.call-status { font-size: 12px; color: var(--aic-muted); }
.call-status:empty { display: none; }
.icon-btn[aria-pressed="true"] { color: var(--aic-text); background: var(--aic-bubble); }
.mic { border: 1px solid var(--aic-border); background: transparent; color: var(--aic-text); border-radius: 10px; width: 40px; display: grid; place-items: center; }
.mic svg { width: 18px; height: 18px; }
.mic.recording { background: #dc2626; border-color: #dc2626; color: #fff; }
@media (prefers-reduced-motion: no-preference) { .mic.recording { animation: aic-pulse 1.2s ease-in-out infinite; } @keyframes aic-pulse { 50% { opacity: .6; } } }
.footer { text-align: center; font-size: 11px; color: var(--aic-muted); padding: 0 0 8px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

@media (max-width: 480px) {
  .root:not(.inline) .panel { position: fixed; inset: 0; width: 100%; height: 100%; max-height: none; border-radius: 0; }
}
@media (prefers-reduced-motion: no-preference) {
  .panel { animation: aic-in .15s ease-out; }
  @keyframes aic-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
}
`;
