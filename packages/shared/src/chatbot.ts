import { z } from "zod";

/** Provider identifiers. Adapters for each live in the ai-providers package. */
export const providerSchema = z.enum(["openai", "anthropic", "gemini", "deepseek", "openai-compatible", "neon-gateway"]);
export type Provider = z.infer<typeof providerSchema>;

export const providerLabels: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  deepseek: "DeepSeek",
  "openai-compatible": "OpenAI-compatible",
  "neon-gateway": "Neon AI Gateway",
};

export const modelRefSchema = z.object({
  provider: providerSchema,
  model: z.string().trim().min(1).max(120),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

export const chatbotSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  systemPrompt: z.string().max(8000).default(""),
  welcomeMessage: z.string().max(500).default("Hi! How can I help you today?"),
  suggestedQuestions: z.array(z.string().trim().min(1).max(160)).max(6).default([]),
  provider: providerSchema.default("openai"),
  model: z.string().trim().min(1).max(120),
  temperature: z.number().min(0, "Temperature must be between 0 and 2").max(2, "Temperature must be between 0 and 2").default(0.3),
  maxOutputTokens: z.number().int().min(64, "Max output tokens must be at least 64").max(8192, "Max output tokens must be at most 8192").default(1024),
  /** Tried in order when the primary model fails before producing any output. */
  fallbacks: z.array(modelRefSchema).max(2).default([]),
  position: z.enum(["bottom-right", "bottom-left"]).default("bottom-right"),
  theme: z.enum(["light", "dark", "auto"]).default("auto"),
});
export type ChatbotSettings = z.infer<typeof chatbotSettingsSchema>;

/**
 * Public chatbot identifier. It identifies a chatbot; it is NOT an authorization credential.
 * Access to chat endpoints is governed by origin allowlists and short-lived session tokens.
 */
export const publicChatbotIdSchema = z.string().regex(/^cb_[A-Za-z0-9]{16,64}$/, "Invalid chatbot id");

/** Retrieval scope: a knowledge source is either global (explicitly assigned) or chatbot-specific. */
export const knowledgeScopeSchema = z.enum(["global", "chatbot"]);
export type KnowledgeScope = z.infer<typeof knowledgeScopeSchema>;

/** Splits text into overlapping chunks. Pure function, suitable for unit tests. */
export function chunkText(text: string, size = 1000, overlap = 150): string[] {
  if (size <= 0) throw new RangeError("size must be positive");
  if (overlap < 0 || overlap >= size) throw new RangeError("overlap must be in [0, size)");
  const cleaned = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (cleaned.length === 0) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < cleaned.length) {
    const end = Math.min(start + size, cleaned.length);
    chunks.push(cleaned.slice(start, end).trim());
    if (end === cleaned.length) break;
    start = end - overlap;
  }
  return chunks.filter((c) => c.length > 0);
}
