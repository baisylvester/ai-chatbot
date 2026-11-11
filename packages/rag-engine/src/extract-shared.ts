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

