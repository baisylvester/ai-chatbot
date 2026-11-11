/**
 * Provider adapters. Each adapter turns a (provider, model, options) request plus server-side
 * credentials into a LangChain chat model. Provider-specific details stay in this file; the
 * conversation engine only sees BaseChatModel.
 *
 * Credentials are read from a plain env object (process.env on the server). They are never
 * accepted from a request and never returned to a client.
 */
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { providerLabels, type Provider } from "@chatbot/shared";

export type ProviderEnv = Record<string, string | undefined>;

export interface ModelOptions {
  provider: Provider;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Per-request timeout. Default 60s. */
  timeoutMs?: number;
  /** Retries for transient errors (429/5xx/network), with exponential backoff. Default 2. */
  maxRetries?: number;
}

export interface ProviderCapabilities {
  streaming: boolean;
  /** Token usage is reported on streamed responses. */
  streamingUsage: boolean;
  systemPrompt: boolean;
}

interface ProviderAdapter {
  label: string;
  /** Env variables that must be set for the provider to work. */
  requiredEnv: string[];
  capabilities: ProviderCapabilities;
  create(opts: Required<Omit<ModelOptions, "provider">>, env: ProviderEnv): BaseChatModel;
}

const full: ProviderCapabilities = { streaming: true, streamingUsage: true, systemPrompt: true };

function openAICompatible(apiKey: string, baseURL: string | undefined, o: Required<Omit<ModelOptions, "provider">>) {
  return new ChatOpenAI({
    model: o.model,
    apiKey,
    temperature: o.temperature,
    maxTokens: o.maxOutputTokens,
    timeout: o.timeoutMs,
    maxRetries: o.maxRetries,
    streamUsage: true,
    configuration: baseURL ? { baseURL } : undefined,
  });
}

const adapters: Record<Provider, ProviderAdapter> = {
  openai: {
    label: providerLabels.openai,
    requiredEnv: ["OPENAI_API_KEY"],
    capabilities: full,
    create: (o, env) => openAICompatible(env.OPENAI_API_KEY!, undefined, o),
  },
  anthropic: {
    label: providerLabels.anthropic,
    requiredEnv: ["ANTHROPIC_API_KEY"],
    capabilities: full,
    create: (o, env) =>
      new ChatAnthropic({
        model: o.model,
        apiKey: env.ANTHROPIC_API_KEY,
        temperature: o.temperature,
        maxTokens: o.maxOutputTokens,
        maxRetries: o.maxRetries,
        clientOptions: { timeout: o.timeoutMs },
      }),
  },
  gemini: {
    label: providerLabels.gemini,
    requiredEnv: ["GOOGLE_GENERATIVE_AI_API_KEY"],
    capabilities: full,
    create: (o, env) =>
      new ChatGoogleGenerativeAI({
        model: o.model,
        apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
        temperature: o.temperature,
        maxOutputTokens: o.maxOutputTokens,
        maxRetries: o.maxRetries,
      }),
  },
  deepseek: {
    label: providerLabels.deepseek,
    requiredEnv: ["DEEPSEEK_API_KEY"],
    capabilities: full,
    create: (o, env) => openAICompatible(env.DEEPSEEK_API_KEY!, env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", o),
  },
  "openai-compatible": {
    label: providerLabels["openai-compatible"],
    requiredEnv: ["OPENAI_COMPATIBLE_BASE_URL"],
    // Local / self-hosted servers vary; usage reporting on streams is not guaranteed.
    capabilities: { streaming: true, streamingUsage: false, systemPrompt: true },
    create: (o, env) =>
      // Many local servers (Ollama, vLLM) accept any key; a placeholder keeps the OpenAI client happy.
      openAICompatible(env.OPENAI_COMPATIBLE_API_KEY || "not-needed", env.OPENAI_COMPATIBLE_BASE_URL, o),
  },
  "neon-gateway": {
    label: providerLabels["neon-gateway"],
    requiredEnv: ["NEON_AI_GATEWAY_BASE_URL", "NEON_AI_GATEWAY_TOKEN"],
    capabilities: full,
    // Unified OpenAI Chat Completions dialect; works for every catalog model.
    create: (o, env) =>
      openAICompatible(env.NEON_AI_GATEWAY_TOKEN!, `${env.NEON_AI_GATEWAY_BASE_URL!.replace(/\/+$/, "")}/v1`, o),
  },
};

export class ProviderNotConfiguredError extends Error {
  readonly provider: Provider;
  readonly missing: string[];
  constructor(provider: Provider, missing: string[]) {
    super(`${providerLabels[provider]} is not configured on the server (missing ${missing.join(", ")}).`);
    this.name = "ProviderNotConfiguredError";
    this.provider = provider;
    this.missing = missing;
  }
}

export function missingEnv(provider: Provider, env: ProviderEnv): string[] {
  return adapters[provider].requiredEnv.filter((k) => !env[k]?.trim());
}

export function isProviderConfigured(provider: Provider, env: ProviderEnv): boolean {
  return missingEnv(provider, env).length === 0;
}

export function providerCapabilities(provider: Provider): ProviderCapabilities {
  return adapters[provider].capabilities;
}

/** Lists every provider with whether the server has credentials for it. Safe to show to admins. */
export function listProviders(env: ProviderEnv) {
  return (Object.keys(adapters) as Provider[]).map((id) => ({
    id,
    label: adapters[id].label,
    configured: isProviderConfigured(id, env),
    capabilities: adapters[id].capabilities,
  }));
}

/** Builds a chat model, or throws ProviderNotConfiguredError when credentials are missing. */
export function createChatModel(opts: ModelOptions, env: ProviderEnv): BaseChatModel {
  const missing = missingEnv(opts.provider, env);
  if (missing.length) throw new ProviderNotConfiguredError(opts.provider, missing);
  return adapters[opts.provider].create(
    {
      model: opts.model,
      temperature: opts.temperature ?? 0.3,
      maxOutputTokens: opts.maxOutputTokens ?? 1024,
      timeoutMs: opts.timeoutMs ?? 60_000,
      maxRetries: opts.maxRetries ?? 2,
    },
    env,
  );
}
