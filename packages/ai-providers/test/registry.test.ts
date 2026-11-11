import { describe, expect, it } from "vitest";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import {
  anthropicAcceptsTemperature,
  createChatModel,
  isProviderConfigured,
  listProviders,
  ProviderNotConfiguredError,
} from "../src/index.ts";

const env = {
  OPENAI_API_KEY: "sk-test",
  ANTHROPIC_API_KEY: "ak-test",
  GOOGLE_GENERATIVE_AI_API_KEY: "g-test",
  DEEPSEEK_API_KEY: "ds-test",
  OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1",
  NEON_AI_GATEWAY_BASE_URL: "https://br-x-api.ai.ap-southeast-1.aws.neon.tech/",
  NEON_AI_GATEWAY_TOKEN: "nt_live_test",
};

describe("createChatModel", () => {
  it("builds the right LangChain class per provider", () => {
    expect(createChatModel({ provider: "openai", model: "gpt-4.1-mini" }, env)).toBeInstanceOf(ChatOpenAI);
    expect(createChatModel({ provider: "anthropic", model: "claude-haiku-4-5" }, env)).toBeInstanceOf(ChatAnthropic);
    expect(createChatModel({ provider: "gemini", model: "gemini-2.5-flash" }, env)).toBeInstanceOf(ChatGoogleGenerativeAI);
    expect(createChatModel({ provider: "deepseek", model: "deepseek-chat" }, env)).toBeInstanceOf(ChatOpenAI);
    expect(createChatModel({ provider: "openai-compatible", model: "llama3" }, env)).toBeInstanceOf(ChatOpenAI);
    expect(createChatModel({ provider: "neon-gateway", model: "claude-haiku-4-5" }, env)).toBeInstanceOf(ChatOpenAI);
  });

  it("applies options", () => {
    const m = createChatModel(
      { provider: "openai", model: "gpt-4.1-mini", temperature: 0.9, maxOutputTokens: 256, timeoutMs: 5000, maxRetries: 0 },
      env,
    ) as ChatOpenAI;
    expect(m.model).toBe("gpt-4.1-mini");
    expect(m.temperature).toBe(0.9);
    expect(m.maxTokens).toBe(256);
    expect(m.timeout).toBe(5000);
  });

  it("omits temperature for Claude models that reject it", () => {
    for (const model of ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-1", "claude-3-5-haiku-latest"]) expect(anthropicAcceptsTemperature(model)).toBe(true);
    for (const model of ["claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-5-5", "claude-fable-5-2"]) expect(anthropicAcceptsTemperature(model)).toBe(false);
    const current = createChatModel({ provider: "anthropic", model: "claude-haiku-5-5", temperature: 0.3 }, env) as ChatAnthropic;
    expect(current.temperature).toBeUndefined();
    const older = createChatModel({ provider: "anthropic", model: "claude-haiku-4-5", temperature: 0.3 }, env) as ChatAnthropic;
    expect(older.temperature).toBe(0.3);
  });

  it("points OpenAI-compatible providers at the right base URL", () => {
    const gateway = createChatModel({ provider: "neon-gateway", model: "m" }, env) as ChatOpenAI;
    expect(gateway.clientConfig.baseURL).toBe("https://br-x-api.ai.ap-southeast-1.aws.neon.tech/v1");
    const deepseek = createChatModel({ provider: "deepseek", model: "m" }, env) as ChatOpenAI;
    expect(deepseek.clientConfig.baseURL).toBe("https://api.deepseek.com");
    const local = createChatModel({ provider: "openai-compatible", model: "m" }, env) as ChatOpenAI;
    expect(local.clientConfig.baseURL).toBe("http://localhost:11434/v1");
  });

  it("throws a descriptive error when credentials are missing, without echoing values", () => {
    expect(() => createChatModel({ provider: "anthropic", model: "x" }, {})).toThrow(ProviderNotConfiguredError);
    try {
      createChatModel({ provider: "neon-gateway", model: "x" }, { NEON_AI_GATEWAY_BASE_URL: "https://h" });
    } catch (err) {
      expect((err as ProviderNotConfiguredError).missing).toEqual(["NEON_AI_GATEWAY_TOKEN"]);
      expect((err as Error).message).toContain("Neon AI Gateway");
    }
  });

  it("treats blank variables as missing", () => {
    expect(isProviderConfigured("openai", { OPENAI_API_KEY: "  " })).toBe(false);
  });
});

describe("listProviders", () => {
  it("reports configuration without exposing secrets", () => {
    const list = listProviders({ OPENAI_API_KEY: "sk-secret" });
    expect(list.find((p) => p.id === "openai")?.configured).toBe(true);
    expect(list.find((p) => p.id === "anthropic")?.configured).toBe(false);
    expect(JSON.stringify(list)).not.toContain("sk-secret");
  });
});
