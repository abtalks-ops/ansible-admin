// Pure helpers for the nightly update: compare two chunk lists and work out what needs enrichment.
// Chunk ids are content hashes, so "changed" means a new id at the same place (URL + heading trail)
// as an id that went away. Unchanged ids keep their enrichment files and cached vectors.

export interface ChunkLine {
  chunk_id: string;
  chunk_hash: string;
  source: string;
  url: string;
  headings: string[];
  fqcn: string | null;
  licence: string;
  text: string;
}

export interface Delta {
  unchanged: string[];
  /** new id -> the id it replaced at the same URL and heading trail */
  changed: Array<{ id: string; previous: string }>;
  added: string[];
  removed: string[];
}

const place = (c: ChunkLine) => `${c.url}\0${c.headings.join("\0")}`;

export function diffChunks(before: ChunkLine[], after: ChunkLine[]): Delta {
  const old = new Map(before.map((c) => [c.chunk_id, c]));
  const now = new Set(after.map((c) => c.chunk_id));
  const gone = before.filter((c) => !now.has(c.chunk_id));
  // Removed chunks by place; a section split into several chunks pairs them up in order.
  const byPlace = new Map<string, string[]>();
  for (const c of gone) byPlace.set(place(c), [...(byPlace.get(place(c)) ?? []), c.chunk_id]);
  const d: Delta = { unchanged: [], changed: [], added: [], removed: [] };
  const replaced = new Set<string>();
  for (const c of after) {
    if (old.has(c.chunk_id)) {
      d.unchanged.push(c.chunk_id);
      continue;
    }
    const prev = byPlace.get(place(c))?.shift();
    if (prev) {
      d.changed.push({ id: c.chunk_id, previous: prev });
      replaced.add(prev);
    } else d.added.push(c.chunk_id);
  }
  d.removed = gone.map((c) => c.chunk_id).filter((id) => !replaced.has(id));
  return d;
}

/** Chunks that have no enrichment file yet, in chunk-list order. */
export function needsEnrichment(chunks: ChunkLine[], enriched: Set<string>): ChunkLine[] {
  return chunks.filter((c) => !enriched.has(c.chunk_id));
}

/** Enrichment files whose id is no longer any chunk's id. */
export function orphans(chunks: ChunkLine[], enriched: Iterable<string>): string[] {
  const ids = new Set(chunks.map((c) => c.chunk_id));
  return [...enriched].filter((id) => !ids.has(id)).sort();
}

export const parseJsonl = (s: string): ChunkLine[] =>
  s.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ChunkLine);
