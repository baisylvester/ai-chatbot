/**
 * Estimated model prices in USD per 1 million tokens, used only for the analytics "estimated cost".
 * Provider prices change: check them and edit this table for your contracts. Unknown models show no
 * estimate rather than a guess. Matching is by exact model id, then by longest known prefix.
 */
export const MODEL_PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "deepseek-chat": { input: 0.27, output: 1.1 },
};

export const PRICES_AS_OF = "2026-11 (estimates; edit packages/shared/src/pricing.ts)";

export function priceFor(model: string): { input: number; output: number } | null {
  const id = model.toLowerCase();
  if (MODEL_PRICES_PER_MTOK[id]) return MODEL_PRICES_PER_MTOK[id]!;
  const prefix = Object.keys(MODEL_PRICES_PER_MTOK)
    .filter((k) => id.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? MODEL_PRICES_PER_MTOK[prefix]! : null;
}

/** Estimated USD cost, or null when the model's price is unknown. */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = priceFor(model);
  return p ? (inputTokens * p.input + outputTokens * p.output) / 1_000_000 : null;
}
