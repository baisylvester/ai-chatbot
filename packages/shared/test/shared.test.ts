import { describe, expect, it } from "vitest";
import { chunkText, createOrganizationSchema, domainSchema, isOriginAllowed, publicChatbotIdSchema } from "../src/index.ts";

describe("slug and organization validation", () => {
  it("accepts a valid organization", () => {
    expect(createOrganizationSchema.parse({ name: " Acme ", slug: "acme-inc" })).toEqual({ name: "Acme", slug: "acme-inc" });
  });

  it("rejects invalid slugs", () => {
    expect(() => createOrganizationSchema.parse({ name: "Acme", slug: "Acme Inc" })).toThrow();
    expect(() => createOrganizationSchema.parse({ name: "Acme", slug: "-bad" })).toThrow();
  });
});

describe("domainSchema", () => {
  it("normalizes case and rejects URLs with schemes or paths", () => {
    expect(domainSchema.parse("Example.COM")).toBe("example.com");
    expect(() => domainSchema.parse("https://example.com")).toThrow();
    expect(() => domainSchema.parse("example.com/path")).toThrow();
  });
});

describe("isOriginAllowed", () => {
  const allowed = ["example.com"];

  it("allows the exact domain and its subdomains over https", () => {
    expect(isOriginAllowed("https://example.com", allowed)).toBe(true);
    expect(isOriginAllowed("https://shop.example.com", allowed)).toBe(true);
  });

  it("rejects look-alike domains", () => {
    expect(isOriginAllowed("https://evilexample.com", allowed)).toBe(false);
    expect(isOriginAllowed("https://example.com.evil.net", allowed)).toBe(false);
  });

  it("rejects plain http except localhost", () => {
    expect(isOriginAllowed("http://example.com", allowed)).toBe(false);
    expect(isOriginAllowed("http://localhost:3000", ["localhost"])).toBe(true);
  });

  it("rejects malformed origins", () => {
    expect(isOriginAllowed("not a url", allowed)).toBe(false);
  });
});

describe("publicChatbotIdSchema", () => {
  it("accepts well-formed ids and rejects others", () => {
    expect(publicChatbotIdSchema.safeParse("cb_abcdefghijklmnop").success).toBe(true);
    expect(publicChatbotIdSchema.safeParse("cb_short").success).toBe(false);
  });
});

describe("chunkText", () => {
  it("returns no chunks for blank input", () => {
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("keeps chunks within size and overlaps consecutive chunks", () => {
    const text = "a".repeat(2500);
    const chunks = chunkText(text, 1000, 100);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
  });

  it("validates its parameters", () => {
    expect(() => chunkText("x", 0)).toThrow(RangeError);
    expect(() => chunkText("x", 10, 10)).toThrow(RangeError);
  });
});

describe("pricing", () => {
  it("estimates cost by exact id or dated variant, and returns null for unknown models", async () => {
    const { estimateCost, priceFor } = await import("../src/index.ts");
    expect(estimateCost("gpt-4.1-mini", 1_000_000, 500_000)).toBeCloseTo(0.4 + 0.8, 6);
    expect(priceFor("gpt-4.1-mini-2025-04-14")).toEqual({ input: 0.4, output: 1.6 });
    expect(priceFor("gpt-4.1-2025-04-14")).toEqual({ input: 2, output: 8 });
    expect(estimateCost("mock-1", 100, 100)).toBeNull();
  });
});
