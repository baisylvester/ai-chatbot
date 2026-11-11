/**
 * Structured (JSON-line) logging for production log pipelines (Vercel, Grafana/Loki, Datadog…).
 * Never pass secrets, tokens, message text or personal data as fields.
 */
type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", event: string, fields: Fields = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }, (_k, v) =>
    v instanceof Error ? { name: v.name, message: v.message } : v,
  );
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const log = {
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
};
