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

import { assertSafeZip, ExtractionError, MAX_EXTRACTED_CHARS, MAX_PDF_PAGES, normalizeText } from "./extract-shared.ts";
export { assertSafeZip, ExtractionError, MAX_EXTRACTED_CHARS, MAX_PDF_PAGES, MAX_ZIP_UNCOMPRESSED_BYTES, normalizeText } from "./extract-shared.ts";

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
