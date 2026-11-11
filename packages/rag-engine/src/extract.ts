/**
 * Text extraction for supported knowledge formats. Input is untrusted: sizes are capped and
 * formats are detected from content type and file extension, not trusted blindly.
 */
import { convert } from "html-to-text";
import mammoth from "mammoth";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_EXTRACTED_CHARS = 2_000_000;

export type SupportedFormat = "pdf" | "docx" | "txt" | "md" | "html";

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

const byExtension: Record<string, SupportedFormat> = {
  pdf: "pdf",
  docx: "docx",
  txt: "txt",
  text: "txt",
  md: "md",
  markdown: "md",
  html: "html",
  htm: "html",
};

const byMime: Record<string, SupportedFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/html": "html",
};

/** Picks a format from the file name first (browsers often send generic MIME types), then MIME type. */
export function detectFormat(fileName: string, mimeType?: string): SupportedFormat | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  return byExtension[ext] ?? (mimeType ? byMime[mimeType.split(";")[0]!.trim().toLowerCase()] ?? null : null);
}

/** Collapses whitespace noise while keeping paragraph breaks. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "nav", format: "skip" },
      { selector: "footer", format: "skip" },
      { selector: "noscript", format: "skip" },
    ],
  });
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  let control = 0;
  for (const b of sample) if (b === 0 || (b < 9 && b !== 0)) control++;
  return control > 0;
}

export async function extractText(bytes: Uint8Array, format: SupportedFormat): Promise<string> {
  if (bytes.byteLength === 0) throw new ExtractionError("The file is empty");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new ExtractionError("The file is larger than 10 MB");

  let text: string;
  try {
    switch (format) {
      case "pdf": {
        if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new ExtractionError("Not a valid PDF file");
        const pdf = await getDocumentProxy(new Uint8Array(bytes));
        text = (await extractPdfText(pdf, { mergePages: true })).text;
        break;
      }
      case "docx": {
        // DOCX files are ZIP archives ("PK" header).
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ExtractionError("Not a valid DOCX file");
        text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
        break;
      }
      case "html":
        text = htmlToText(new TextDecoder().decode(bytes));
        break;
      case "txt":
      case "md":
        if (looksBinary(bytes)) throw new ExtractionError("This doesn't look like a text file");
        text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        break;
    }
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    throw new ExtractionError(`Could not read the ${format.toUpperCase()} file`);
  }

  const normalized = normalizeText(text);
  if (!normalized) throw new ExtractionError("No text could be extracted (scanned PDFs need OCR, which isn't supported yet)");
  if (normalized.length > MAX_EXTRACTED_CHARS) throw new ExtractionError("The document has too much text (over 2 million characters)");
  return normalized;
}
