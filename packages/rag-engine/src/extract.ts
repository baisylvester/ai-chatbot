/**
 * Text extraction for supported knowledge formats. Input is untrusted: sizes are capped and
 * formats are detected from content type and file extension, not trusted blindly.
 */
import { convert } from "html-to-text";
import mammoth from "mammoth";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { extractLegacyDoc } from "./legacy-doc.ts";
import { MAX_UPLOAD_BYTES, type SupportedFormat } from "./formats.ts";
export { MAX_UPLOAD_BYTES, detectFormat, type SupportedFormat } from "./formats.ts";

export const MAX_EXTRACTED_CHARS = 2_000_000;
export const MAX_PDF_PAGES = 1000;
/** Total uncompressed size allowed for a DOCX archive (guards against zip bombs). */
export const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_RATIO = 200;
const MAX_ZIP_ENTRIES = 2000;

/**
 * Reads a ZIP's central directory and rejects archives that would inflate to an unsafe size, have
 * an extreme compression ratio, too many entries, or ZIP64 sizes. Runs before any decompression.
 */
export function assertSafeZip(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: signature 0x06054b50, within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ExtractionError("Not a valid DOCX file");
  const entries = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdOffset === 0xffffffff) throw new ExtractionError("This DOCX file is too large to process");
  if (entries > MAX_ZIP_ENTRIES) throw new ExtractionError("This DOCX file has too many parts");
  let total = 0;
  let compressed = 0;
  let p = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new ExtractionError("Not a valid DOCX file");
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    if (csize === 0xffffffff || usize === 0xffffffff) throw new ExtractionError("This DOCX file is too large to process");
    total += usize;
    compressed += csize;
    p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  if (total > MAX_ZIP_UNCOMPRESSED_BYTES || (compressed > 0 && total / compressed > MAX_ZIP_RATIO)) {
    throw new ExtractionError("This DOCX file expands to an unsafe size");
  }
}

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
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
        if (pdf.numPages > MAX_PDF_PAGES) throw new ExtractionError(`The PDF has more than ${MAX_PDF_PAGES} pages`);
        text = (await extractPdfText(pdf, { mergePages: true })).text;
        break;
      }
      case "docx": {
        // DOCX files are ZIP archives ("PK" header). Check the declared sizes before inflating.
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ExtractionError("Not a valid DOCX file");
        assertSafeZip(bytes);
        text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
        break;
      }
      case "doc": {
        const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
        if (bytes.length < 512 || !signature.every((b, i) => bytes[i] === b)) {
          throw new ExtractionError("Not a valid DOC file. Save the document as DOCX and try again.");
        }
        text = await extractLegacyDoc(bytes);
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
