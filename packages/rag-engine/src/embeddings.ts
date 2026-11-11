/**
 * Embedding providers. The database column is vector(1536), so every provider is configured to
 * return 1536 dimensions, and each chunk records the model that produced it (vectors from different
 * models are never compared).
 */
import { createHash } from "node:crypto";
import type { Embeddings } from "@langchain/core/embeddings";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { OpenAIEmbeddings } from "@langchain/openai";

export const EMBEDDING_DIMENSIONS = 1536;

export type EmbeddingProviderId = "openai" | "gemini" | "neon-gateway" | "mock";
export type EmbeddingEnv = Record<string, string | undefined>;

export interface Embedder {
  /** Stored on each chunk, e.g. "openai:text-embedding-3-small". */
  modelId: string;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export class EmbeddingNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingNotConfiguredError";
  }
}

function fromLangChain(modelId: string, lc: Embeddings): Embedder {
  const check = (v: number[]) => {
    if (v.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`${modelId} returned ${v.length} dimensions; ${EMBEDDING_DIMENSIONS} are required`);
    }
    return v;
  };
  return {
    modelId,
    embedDocuments: async (texts) => (await lc.embedDocuments(texts)).map(check),
    embedQuery: async (text) => check(await lc.embedQuery(text)),
  };
}

/**
 * Development/test-only embedder: hashes words into a 1536-dim vector. It captures word overlap,
 * not meaning, so it must never be used for real retrieval quality. Selected only when
 * EMBEDDING_PROVIDER=mock is set explicitly.
 */
export function mockEmbedder(): Embedder {
  const embed = (text: string) => {
    const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      const h = createHash("sha256").update(word).digest();
      v[h.readUInt16BE(0) % EMBEDDING_DIMENSIONS]! += h[2]! & 1 ? 1 : -1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  return {
    modelId: "mock:hash-1536",
    embedDocuments: async (texts) => texts.map(embed),
    embedQuery: async (text) => embed(text),
  };
}

const present = (env: EmbeddingEnv, ...keys: string[]) => keys.every((k) => env[k]?.trim());

/**
 * Chooses the embedding provider: EMBEDDING_PROVIDER if set, otherwise the first configured of
 * OpenAI, Gemini, Neon AI Gateway. Anthropic and DeepSeek have no embedding API.
 */
export function createEmbedder(env: EmbeddingEnv): Embedder {
  const requested = env.EMBEDDING_PROVIDER?.trim() as EmbeddingProviderId | undefined;
  const choice: EmbeddingProviderId | undefined =
    requested ||
    (present(env, "OPENAI_API_KEY")
      ? "openai"
      : present(env, "GOOGLE_GENERATIVE_AI_API_KEY")
        ? "gemini"
        : present(env, "NEON_AI_GATEWAY_BASE_URL", "NEON_AI_GATEWAY_TOKEN")
          ? "neon-gateway"
          : undefined);

  switch (choice) {
    case "openai": {
      if (!present(env, "OPENAI_API_KEY")) throw new EmbeddingNotConfiguredError("OPENAI_API_KEY is not set");
      const model = env.EMBEDDING_MODEL || "text-embedding-3-small";
      return fromLangChain(
        `openai:${model}`,
        new OpenAIEmbeddings({ apiKey: env.OPENAI_API_KEY, model, dimensions: EMBEDDING_DIMENSIONS, maxRetries: 2 }),
      );
    }
    case "gemini": {
      if (!present(env, "GOOGLE_GENERATIVE_AI_API_KEY")) throw new EmbeddingNotConfiguredError("GOOGLE_GENERATIVE_AI_API_KEY is not set");
      const model = env.EMBEDDING_MODEL || "gemini-embedding-001";
      // Gemini embedding models default to 3072 dims; request 1536 to match the column.
      const lc = new GoogleGenerativeAIEmbeddings({
        apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
        model,
        maxRetries: 2,
        outputDimensionality: EMBEDDING_DIMENSIONS,
      });
      return fromLangChain(`gemini:${model}`, lc);
    }
    case "neon-gateway": {
      if (!present(env, "NEON_AI_GATEWAY_BASE_URL", "NEON_AI_GATEWAY_TOKEN")) {
        throw new EmbeddingNotConfiguredError("NEON_AI_GATEWAY_BASE_URL and NEON_AI_GATEWAY_TOKEN are not set");
      }
      const model = env.EMBEDDING_MODEL || "text-embedding-3-small";
      return fromLangChain(
        `neon-gateway:${model}`,
        new OpenAIEmbeddings({
          apiKey: env.NEON_AI_GATEWAY_TOKEN,
          model,
          dimensions: EMBEDDING_DIMENSIONS,
          maxRetries: 2,
          configuration: { baseURL: `${env.NEON_AI_GATEWAY_BASE_URL!.replace(/\/+$/, "")}/v1` },
        }),
      );
    }
    case "mock":
      return mockEmbedder();
    default:
      throw new EmbeddingNotConfiguredError(
        "No embedding provider is configured. Set OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY or the Neon AI Gateway variables (Anthropic and DeepSeek don't offer embeddings).",
      );
  }
}
