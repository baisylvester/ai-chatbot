/** Browser-safe upload policy. Keep parsers and Node dependencies out of the admin upload bundle. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_ACCEPT = ".pdf,.doc,.docx,.txt,.text,.md,.markdown,.html,.htm,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/html";
export type SupportedFormat = "pdf" | "doc" | "docx" | "txt" | "md" | "html";

const byExtension: Record<string, SupportedFormat> = {
  pdf: "pdf", doc: "doc", docx: "docx", txt: "txt", text: "txt",
  md: "md", markdown: "md", html: "html", htm: "html",
};
const byMime: Record<string, SupportedFormat> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt", "text/markdown": "md", "text/x-markdown": "md", "text/html": "html",
};

/** Browsers sometimes send generic MIME types, so prefer the filename. Reject known unsupported suffixes. */
export function detectFormat(fileName: string, mimeType?: string): SupportedFormat | null {
  const ext = fileName.toLowerCase().split(".");
  if (ext.length > 1) return byExtension[ext.at(-1)!] ?? null;
  return mimeType ? byMime[mimeType.split(";")[0]!.trim().toLowerCase()] ?? null : null;
}
