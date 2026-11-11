import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertPublicUrl,
  chunkDocument,
  contentHash,
  createEmbedder,
  detectFormat,
  EMBEDDING_DIMENSIONS,
  EmbeddingNotConfiguredError,
  extractText,
  fetchPage,
  formatContext,
  isPublicAddress,
  mockEmbedder,
  normalizeText,
  reciprocalRankFusion,
} from "../src/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** A tiny one-page PDF with the text "Hello PDF world". pdf.js rebuilds the xref table if offsets are off. */
const tinyPdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 20 40 Td (Hello PDF world) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;

describe("format detection and extraction", () => {
  it("detects formats from extension, then MIME type", () => {
    expect(detectFormat("Report.PDF")).toBe("pdf");
    expect(detectFormat("notes.md")).toBe("md");
    expect(detectFormat("file", "text/plain; charset=utf-8")).toBe("txt");
    expect(detectFormat("photo.png", "image/png")).toBeNull();
  });

  it("normalizes whitespace but keeps paragraphs", () => {
    expect(normalizeText("a \t b\r\n\r\n\r\n\r\nc d  ")).toBe("a b\n\nc d");
  });

  it("extracts text and markdown, and rejects binary or empty input", async () => {
    expect(await extractText(enc("# Title\n\nBody text"), "md")).toBe("# Title\n\nBody text");
    await expect(extractText(new Uint8Array([0, 1, 2, 3, 0, 5]), "txt")).rejects.toThrow(/text file/);
    await expect(extractText(new Uint8Array(), "txt")).rejects.toThrow(/empty/);
    await expect(extractText(enc("   \n  "), "txt")).rejects.toThrow(/No text/);
  });

  it("extracts readable text from HTML without scripts, styles or navigation", async () => {
    const html = `<html><head><style>.x{}</style><script>alert(1)</script></head>
      <body><nav>Menu</nav><h1>Store hours</h1><p>Open <b>9am</b> to 5pm.</p><footer>©</footer></body></html>`;
    const text = await extractText(enc(html), "html");
    expect(text).toContain("STORE HOURS");
    expect(text).toContain("Open 9am to 5pm.");
    expect(text).not.toMatch(/alert|Menu|\.x\{/);
  });

  it("extracts text from a PDF and rejects files that only claim to be PDFs", async () => {
    expect(await extractText(enc(tinyPdf), "pdf")).toContain("Hello PDF world");
    await expect(extractText(enc("not a pdf"), "pdf")).rejects.toThrow(/valid PDF/);
  });

  it("rejects files that only claim to be DOCX", async () => {
    await expect(extractText(enc("plain text"), "docx")).rejects.toThrow(/valid DOCX/);
  });

  // Uses a local, git-ignored document when present; skipped elsewhere.
  const localDocx = new URL("../../../knowledge_sources/gani-macatoman-public-record.docx", import.meta.url);
  it.skipIf(!existsSync(localDocx))("extracts text from a real DOCX", async () => {
    const text = await extractText(new Uint8Array(readFileSync(localDocx)), "docx");
    expect(text.length).toBeGreaterThan(5000);
    expect(text).toContain("Source register");
  });
});

describe("SSRF protection", () => {
  it("classifies addresses", () => {
    for (const a of ["127.0.0.1", "10.0.0.5", "172.16.3.4", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "100.64.0.1"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ["93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(a), a).toBe(true);
  });

  const resolver = (map: Record<string, string[]>) => async (host: string) => map[host] ?? [];

  it("rejects private targets, odd schemes, ports and credentials", async () => {
    const r = resolver({ "intranet.example": ["10.1.2.3"], "mixed.example": ["93.184.216.34", "127.0.0.1"] });
    await expect(assertPublicUrl("http://localhost/", r)).rejects.toThrow(/not be found|not a public/);
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data", r)).rejects.toThrow(/not a public/);
    await expect(assertPublicUrl("http://[::1]/", r)).rejects.toThrow(/not a public/);
    await expect(assertPublicUrl("https://intranet.example/", r)).rejects.toThrow(/not a public/);
    await expect(assertPublicUrl("https://mixed.example/", r)).rejects.toThrow(/not a public/);
    await expect(assertPublicUrl("file:///etc/passwd", r)).rejects.toThrow(/http and https/);
    await expect(assertPublicUrl("https://example.com:8443/", resolver({ "example.com": ["93.184.216.34"] }))).rejects.toThrow(/standard ports/);
    await expect(assertPublicUrl("https://user:pw@example.com/", resolver({ "example.com": ["93.184.216.34"] }))).rejects.toThrow(/credentials/);
    await expect(assertPublicUrl("https://example.com/page", resolver({ "example.com": ["93.184.216.34"] }))).resolves.toBeInstanceOf(URL);
  });

  it("re-checks every redirect hop", async () => {
    const r = resolver({ "public.example": ["93.184.216.34"], "internal.example": ["192.168.0.10"] });
    const fetchImpl = (async (url: URL) =>
      url.hostname === "public.example"
        ? new Response(null, { status: 302, headers: { location: "http://internal.example/admin" } })
        : new Response("secret", { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    await expect(fetchPage("https://public.example/", { resolve: r, fetchImpl })).rejects.toThrow(/not a public/);
  });

  it("extracts the page title and text", async () => {
    const r = resolver({ "public.example": ["93.184.216.34"] });
    const fetchImpl = (async () =>
      new Response("<html><title>About us</title><body><p>We sell shoes.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof fetch;
    const page = await fetchPage("https://public.example/about", { resolve: r, fetchImpl });
    expect(page.title).toBe("About us");
    expect(page.text).toContain("We sell shoes.");
  });

  it("rejects non-text content types", async () => {
    const r = resolver({ "public.example": ["93.184.216.34"] });
    const fetchImpl = (async () => new Response("x", { status: 200, headers: { "content-type": "application/zip" } })) as unknown as typeof fetch;
    await expect(fetchPage("https://public.example/a.zip", { resolve: r, fetchImpl })).rejects.toThrow(/Unsupported page type/);
  });
});

describe("chunking, hashing, ranking", () => {
  it("splits on natural boundaries within the size limit", async () => {
    const paragraph = "Sentence number one is here. ".repeat(20).trim();
    const text = Array.from({ length: 6 }, () => paragraph).join("\n\n");
    const chunks = await chunkDocument(text, { chunkSize: 700, chunkOverlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(700);
      expect(c.tokenEstimate).toBe(Math.ceil(c.content.length / 4));
    }
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("hashes content for duplicate detection", () => {
    expect(contentHash("abc")).toMatch(/^[a-f0-9]{64}$/);
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });

  it("fuses rankings so items found by both searches rise to the top", () => {
    const fused = reciprocalRankFusion([
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [{ id: "c" }, { id: "d" }, { id: "a" }],
    ]);
    expect(fused.map((f) => f.id).slice(0, 2).sort()).toEqual(["a", "c"]);
    expect(fused).toHaveLength(4);
  });

  it("numbers sources in the context and respects the size budget", () => {
    const ctx = formatContext([
      { title: "Doc A", content: "alpha" },
      { title: "Doc B", content: "beta" },
      { title: "Doc C", content: "x".repeat(500) },
    ], 60);
    expect(ctx).toBe("[1] Doc A\nalpha\n\n[2] Doc B\nbeta");
  });
});

describe("embeddings", () => {
  it("mock embedder returns normalized 1536-dim vectors that reflect word overlap", async () => {
    const e = mockEmbedder();
    const [a, b, c] = await e.embedDocuments(["store opening hours", "opening hours of the store", "refund policy for shoes"]);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(a!, a!)).toBeCloseTo(1, 5);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
  });

  it("chooses a provider from env and explains when none can embed", () => {
    expect(createEmbedder({ OPENAI_API_KEY: "sk-x" }).modelId).toBe("openai:text-embedding-3-small");
    expect(createEmbedder({ GOOGLE_GENERATIVE_AI_API_KEY: "g" }).modelId).toBe("gemini:gemini-embedding-001");
    expect(createEmbedder({ NEON_AI_GATEWAY_BASE_URL: "https://h", NEON_AI_GATEWAY_TOKEN: "t" }).modelId).toBe(
      "neon-gateway:text-embedding-3-small",
    );
    expect(createEmbedder({ EMBEDDING_PROVIDER: "mock" }).modelId).toBe("mock:hash-1536");
    expect(() => createEmbedder({ ANTHROPIC_API_KEY: "a" })).toThrow(EmbeddingNotConfiguredError);
    expect(() => createEmbedder({ EMBEDDING_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
  });
});
