import { createHash } from "node:crypto";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

export interface Chunk {
  index: number;
  content: string;
  /** Rough token estimate (≈4 characters per token) for context budgeting. */
  tokenEstimate: number;
}

export interface ChunkOptions {
  chunkSize?: number;
  chunkOverlap?: number;
}

/** Splits text on paragraph, line, sentence and word boundaries (LangChain recursive splitter). */
export async function chunkDocument(text: string, opts: ChunkOptions = {}): Promise<Chunk[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: opts.chunkSize ?? 1200,
    chunkOverlap: opts.chunkOverlap ?? 200,
    separators: ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""],
  });
  const parts = await splitter.splitText(text);
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((content, index) => ({ index, content, tokenEstimate: Math.ceil(content.length / 4) }));
}

/** SHA-256 of normalized text, used for duplicate detection within a knowledge source. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
