import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { attachmentKind, AttachmentReadError, readAttachmentText, readZipEntry } from "../src/index.ts";

/** A minimal one-entry ZIP (deflated) for tests. `declaredSize` can lie, like a hostile archive. */
function zip(name: string, content: Buffer, declaredSize = content.length): Uint8Array {
  const data = deflateRawSync(content);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(declaredSize, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(declaredSize, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(cdOffset, 16);
  return new Uint8Array(Buffer.concat([local, nameBytes, data, central, nameBytes, end]));
}
const file = (filename: string, mimeType: string, bytes: Uint8Array) => ({ filename, mimeType, bytes });

describe("attachment text", () => {
  it("detects readable kinds", () => {
    expect(attachmentKind("a.PDF", "")).toBe("pdf");
    expect(attachmentKind("x", "image/png")).toBe("image");
    expect(attachmentKind("a.doc", "application/msword")).toBeNull();
    expect(attachmentKind("a.zip", "application/zip")).toBeNull();
  });
  it("reads text, HTML and DOCX without a model", async () => {
    expect(await readAttachmentText(file("a.txt", "text/plain", Buffer.from("Hello\r\nworld")))).toBe("Hello\nworld");
    expect(await readAttachmentText(file("a.html", "text/html", Buffer.from("<p>Hi <b>there</b></p><script>x()</script>")))).toBe("Hi there");
    const xml = '<w:document><w:body><w:p><w:r><w:t>Terms &amp; conditions</w:t></w:r></w:p><w:p><w:r><w:t>Pay in 30 days</w:t></w:r></w:p></w:body></w:document>';
    expect(await readAttachmentText(file("t.docx", "", zip("word/document.xml", Buffer.from(xml))))).toBe("Terms & conditions\nPay in 30 days");
  });
  it("stops inflating a DOCX that expands beyond the limit, whatever it declares", async () => {
    const bomb = zip("word/document.xml", Buffer.alloc(2_000_000, 0x41), 10);
    await expect(readZipEntry(bomb, "word/document.xml", 1_000_000)).rejects.toBeInstanceOf(AttachmentReadError);
    await expect(readAttachmentText(file("x.docx", "", new Uint8Array([1, 2, 3])))).rejects.toBeInstanceOf(AttachmentReadError);
  });
  it("reads PDFs through Gemini only when a key is configured", async () => {
    const pdf = file("a.pdf", "application/pdf", Buffer.from("%PDF-1.4"));
    expect(await readAttachmentText(pdf)).toBeNull();
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ candidates: [{ content: { parts: [{ text: "Invoice 42\nTotal 10" }] } }] }));
    expect(await readAttachmentText(pdf, { geminiKey: "k", geminiModel: "gemini-flash-latest", fetchFn: fetchFn as unknown as typeof fetch })).toBe("Invoice 42\nTotal 10");
    const body = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body));
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe("application/pdf");
    expect(body.systemInstruction.parts[0].text).toContain("untrusted");
    expect((fetchFn.mock.calls[0]![1]!.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
  });
});
