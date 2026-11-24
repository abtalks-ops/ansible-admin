// Index format and hybrid search, shared by the build pipeline (evaluation) and the PWA.
// Runs in Node and in the browser: no Node or DOM APIs here.

export const INDEX_FORMAT = 1;

/** One retrievable passage. Short keys keep shard JSON small. */
export interface Chunk {
  id: string; // stable content hash
  t: string; // heading trail, e.g. "Playbook guide > Using variables > Variable precedence"
  u: string; // source URL
  x: string; // passage text (Markdown)
  src: string; // source name, e.g. "ansible-core docs"
  lic: string; // licence of the source text
  fq?: string; // module/plugin FQCN, when the chunk documents one
  sum?: string; // build-time summary (Opus enrichment)
  qs?: string[]; // build-time questions this chunk answers (Opus enrichment)
  card?: AnswerCard; // vetted answer the app can show verbatim
}

export interface AnswerCard {
  title: string;
  answer_md: string;
  source_url: string;
}

export interface ShardMeta {
  format: number;
  shard: string;
  product: string;
  version: string;
  dims: number;
  chunks: Chunk[];
  /** Vector row -> chunk index. A chunk can own several rows (its text, each generated question). */
  rows: number[];
}

export interface ShardFile {
  path: string; // content-addressed: <name>.<sha256 prefix>.<ext>
  sha256: string;
  bytes: number;
}

export interface Manifest {
  index_format: number;
  built_at: string;
  embedder: { id: string; dtype: string; dims: number; pooling: "cls" | "mean"; query_prefix: string };
  shards: Array<{ id: string; product: string; version: string; chunks: number; rows: number; meta: ShardFile; vec: ShardFile }>;
  stats: { chunks: number; rows: number; bytes: number; enriched: number };
}

/** A shard ready to search: metadata plus int8 vectors and per-row scales. */
export interface LoadedShard {
  meta: ShardMeta;
  vecs: Int8Array; // rows * dims
  scales: Float32Array; // one per row
}

// ---------- vector packing ----------

/** Quantizes unit-length float vectors to int8 with one scale per row. */
export function quantize(vectors: Float32Array[], dims: number): Uint8Array {
  const n = vectors.length;
  const buf = new ArrayBuffer(n * dims + n * 4);
  const q = new Int8Array(buf, 0, n * dims);
  const scales = new Float32Array(buf, n * dims, n);
  vectors.forEach((v, r) => {
    let max = 1e-12;
    for (let i = 0; i < dims; i++) max = Math.max(max, Math.abs(v[i]));
    const s = max / 127;
    scales[r] = s;
    for (let i = 0; i < dims; i++) q[r * dims + i] = Math.round(v[i] / s);
  });
  return new Uint8Array(buf);
}

export function unpack(bytes: ArrayBuffer, rows: number, dims: number): { vecs: Int8Array; scales: Float32Array } {
  // Scales start at rows*dims, which may not be 4-byte aligned, so copy them out.
  const vecs = new Int8Array(bytes, 0, rows * dims);
  const scales = new Float32Array(bytes.slice(rows * dims, rows * dims + rows * 4));
  return { vecs, scales };
}

// ---------- BM25 ----------

const STOP = new Set(
  "the a an and or of to in is are be for on with as by it this that from at can you your use using used will not if when which into also may must should how what do does i my me".split(" "),
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9_.]+/g) ?? []) {
    const tok = raw.replace(/^\.+|\.+$/g, "");
    if (tok.length < 2 || STOP.has(tok)) continue;
    out.push(tok);
    // "ansible.builtin.copy" and "become_user" also match "copy" and "become".
    if (/[._]/.test(tok)) for (const p of tok.split(/[._]/)) if (p.length > 1 && !STOP.has(p)) out.push(p);
  }
  return out;
}

export interface Bm25 {
  postings: Map<string, Array<[number, number]>>; // term -> [global chunk index, tf]
  lengths: Float32Array;
  avgLen: number;
}

export function chunkKeywordText(c: Chunk): string {
  // Titles and FQCNs carry most of the signal, so they count twice.
  return `${c.t} ${c.t} ${c.fq ?? ""} ${c.fq ?? ""} ${c.sum ?? ""} ${(c.qs ?? []).join(" ")} ${c.card?.title ?? ""} ${c.x}`;
}

export function buildBm25(chunks: Chunk[]): Bm25 {
  const postings = new Map<string, Array<[number, number]>>();
  const lengths = new Float32Array(chunks.length);
  let total = 0;
  chunks.forEach((c, idx) => {
    const toks = tokenize(chunkKeywordText(c));
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) {
      let list = postings.get(t);
      if (!list) postings.set(t, (list = []));
      list.push([idx, n]);
    }
    lengths[idx] = toks.length;
    total += toks.length;
  });
  return { postings, lengths, avgLen: total / Math.max(chunks.length, 1) };
}

export function bm25Search(idx: Bm25, n: number, query: string, k: number): Array<[number, number]> {
  const K1 = 1.2, B = 0.75;
  const scores = new Map<number, number>();
  for (const term of new Set(tokenize(query))) {
    const list = idx.postings.get(term);
    if (!list) continue;
    const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
    for (const [id, tf] of list) {
      const norm = tf + K1 * (1 - B + (B * idx.lengths[id]) / idx.avgLen);
      scores.set(id, (scores.get(id) ?? 0) + (idf * tf * (K1 + 1)) / norm);
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
}

// ---------- the searchable index ----------

export class SearchIndex {
  chunks: Chunk[] = [];
  private shards: Array<{ s: LoadedShard; offset: number }> = [];
  private bm25: Bm25 | null = null;

  constructor(shards: LoadedShard[]) {
    for (const s of shards) {
      this.shards.push({ s, offset: this.chunks.length });
      this.chunks.push(...s.meta.chunks);
    }
    this.bm25 = buildBm25(this.chunks);
  }

  keyword(query: string, k = 50) {
    return bm25Search(this.bm25!, this.chunks.length, query, k);
  }

  /** Max cosine similarity per chunk over its vector rows. `q` must be unit length. */
  vector(q: Float32Array, k = 50): Array<[number, number]> {
    const best = new Map<number, number>();
    for (const { s, offset } of this.shards) {
      const d = s.meta.dims;
      const { vecs, scales, meta } = s;
      for (let r = 0; r < meta.rows.length; r++) {
        let dot = 0;
        const base = r * d;
        for (let i = 0; i < d; i++) dot += q[i] * vecs[base + i];
        const score = dot * scales[r];
        const c = offset + meta.rows[r];
        if (score > (best.get(c) ?? -Infinity)) best.set(c, score);
      }
    }
    return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  }

  /** Reciprocal rank fusion of keyword and vector results. */
  hybrid(query: string, q: Float32Array | null, k = 5, rrfK = 60): Array<{ chunk: Chunk; score: number }> {
    const fused = new Map<number, number>();
    const add = (list: Array<[number, number]>, w: number) =>
      list.forEach(([c], rank) => fused.set(c, (fused.get(c) ?? 0) + w / (rrfK + rank + 1)));
    add(this.keyword(query), 1);
    if (q) add(this.vector(q), 1);
    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([c, score]) => ({ chunk: this.chunks[c], score }));
  }
}
