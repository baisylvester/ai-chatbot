import { Buffer } from "buffer";
import mammoth from "mammoth/mammoth.browser.js";
import WordOleExtractor from "word-extractor/lib/word-ole-extractor.js";
import BufferReader from "word-extractor/lib/buffer-reader.js";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { convert } from "html-to-text";
import { assertSafeZip, MAX_EXTRACTED_CHARS, MAX_PDF_PAGES, normalizeText } from "../../../packages/rag-engine/src/extract-shared.ts";
import { detectFormat, MAX_UPLOAD_BYTES } from "../../../packages/rag-engine/src/formats.ts";

// A dedicated worker keeps parsing away from the UI and is terminated by the parent on timeout.
self.onmessage = async ({ data: file }) => {
  try {
    if (!(file instanceof File) || !file.size || file.size > MAX_UPLOAD_BYTES) throw Error("Choose a file up to 10 MB.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const format = detectFormat(file.name, file.type);
    let text;
    if (format === "pdf") {
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw Error("Not a valid PDF file.");
      const pdf = await getDocumentProxy(bytes);
      try {
        if (pdf.numPages > MAX_PDF_PAGES) throw Error("The PDF has too many pages.");
        text = (await extractPdfText(pdf, { mergePages: true })).text;
      } finally { await pdf.loadingTask.destroy(); }
    } else if (format === "docx") {
      assertSafeZip(bytes);
      text = (await mammoth.extractRawText({ arrayBuffer: bytes.buffer })).value;
    } else if (format === "doc") {
      const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
      if (bytes.length < 512 || !signature.every((b, i) => bytes[i] === b)) throw Error("Not a valid DOC file.");
      const doc = await new WordOleExtractor().extract(new BufferReader(Buffer.from(bytes)));
      text = [doc.getBody(), doc.getFootnotes(), doc.getEndnotes(), doc.getTextboxes()].join("\n\n");
    } else if (format === "html") {
      text = convert(new TextDecoder().decode(bytes), { wordwrap: false, selectors: [
        { selector: "script", format: "skip" }, { selector: "style", format: "skip" },
        { selector: "nav", format: "skip" }, { selector: "footer", format: "skip" },
      ] });
    } else if (format === "txt" || format === "md") {
      if (bytes.subarray(0, 4096).some(b => b === 0 || b < 9)) throw Error("This does not look like a text file.");
      text = new TextDecoder().decode(bytes);
    } else throw Error("Unsupported file type.");
    text = normalizeText(text);
    if (!text) throw Error("No text found. Scanned PDFs need OCR before uploading.");
    if (text.length > MAX_EXTRACTED_CHARS) throw Error("The document has too much text (over 2 million characters).");
    self.postMessage({ kind: "knowledge-extraction", text });
  } catch (error) {
    self.postMessage({ kind: "knowledge-extraction", error: error instanceof Error ? error.message : "Could not read this file." });
  }
};

