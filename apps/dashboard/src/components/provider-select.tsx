import "server-only";
import { listProviders } from "@chatbot/ai-providers";

const selectClass = "rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700";

/** Provider dropdown. Marks providers the server has no credentials for (checked server-side; no secrets leave the server). */
export function ProviderSelect({
  name,
  label,
  defaultValue,
  allowNone = false,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  allowNone?: boolean;
}) {
  const providers = listProviders(process.env);
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <select name={name} defaultValue={defaultValue ?? (allowNone ? "" : "openai")} className={selectClass}>
        {allowNone && <option value="">None</option>}
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
            {p.configured ? "" : " (not configured)"}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Lists which providers have server credentials, so admins know what will work. */
export function ProviderStatus() {
  const providers = listProviders(process.env);
  return (
    <ul className="grid gap-1 text-sm sm:grid-cols-2">
      {providers.map((p) => (
        <li key={p.id} className="flex items-center gap-2">
          <span aria-hidden className={p.configured ? "text-emerald-600" : "text-zinc-400"}>
            {p.configured ? "●" : "○"}
          </span>
          {p.label}
          <span className="text-zinc-500">{p.configured ? "configured" : "not configured"}</span>
        </li>
      ))}
    </ul>
  );
}
