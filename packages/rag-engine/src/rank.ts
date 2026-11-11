/**
 * Reciprocal Rank Fusion: merges ranked lists from semantic (vector) and keyword (full-text) search
 * without needing their scores to be on the same scale. score = Σ 1 / (k + rank).
 */
export interface Ranked {
  id: string;
}

export function reciprocalRankFusion<T extends Ranked>(lists: T[][], k = 60): (T & { score: number })[] {
  const scores = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, i) => {
      const entry = scores.get(item.id) ?? { item, score: 0 };
      entry.score += 1 / (k + i + 1);
      scores.set(item.id, entry);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).map(({ item, score }) => ({ ...item, score }));
}

/** Formats retrieved chunks as numbered sources for the prompt; numbers match the citations list. */
export function formatContext(chunks: { title: string; content: string }[], maxChars = 8000): string {
  const out: string[] = [];
  let used = 0;
  for (const [i, c] of chunks.entries()) {
    const block = `[${i + 1}] ${c.title}\n${c.content}`;
    if (used + block.length > maxChars) break;
    out.push(block);
    used += block.length;
  }
  return out.join("\n\n");
}
