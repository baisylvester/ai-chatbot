import { describe, expect, it } from "vitest";
import { chunkText, createOrganizationSchema, domainSchema, isOriginAllowed, publicChatbotIdSchema } from "../src";

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
