// Lexical retrieval (BM25) over the Ansible docs index built by `npm run ingest`.
// BM25 needs no embedding service, runs fully offline, and handles Ansible's
// exact-token vocabulary (module names, option names, ANSIBLE_* variables) well.
import fs from "node:fs";
import path from "node:path";

export interface DocChunk {
  id: number;
  source: string; // e.g. "ansible-core docs", "ansible-lint"
  title: string; // heading trail
  url: string;
  text: string;
}

interface Index {
  chunks: DocChunk[];
  postings: Map<string, Array<[number, number]>>; // term -> [chunkId, tf]
  lengths: Float32Array;
  avgLen: number;
}

const INDEX_PATH = path.join(process.cwd(), "data", "index.json");
let cached: Index | null | undefined;

export function tokenize(text: string): string[] {
  // Keep dots and underscores so "ansible.builtin.copy" and "become_user" survive,
  // and also emit their parts so "copy" still matches.
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9_.]+/g) ?? []) {
    const tok = raw.replace(/^\.+|\.+$/g, "");
    if (tok.length < 2 || STOP.has(tok)) continue;
    out.push(tok);
    if (/[._]/.test(tok)) for (const p of tok.split(/[._]/)) if (p.length > 1 && !STOP.has(p)) out.push(p);
  }
  return out;
}

const STOP = new Set(
  "the a an and or of to in is are be for on with as by it this that from at can you your use using used will not if when which into also may must should".split(
    " ",
  ),
);

function load(): Index | null {
  if (cached !== undefined) return cached;
  if (!fs.existsSync(INDEX_PATH)) return (cached = null);
  const chunks: DocChunk[] = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")).chunks;
  const postings = new Map<string, Array<[number, number]>>();
  const lengths = new Float32Array(chunks.length);
  let total = 0;
  for (const c of chunks) {
    const tf = new Map<string, number>();
    // Titles carry a lot of signal, so count them twice.
    const toks = tokenize(`${c.title} ${c.title} ${c.text}`);
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) {
      let list = postings.get(t);
      if (!list) postings.set(t, (list = []));
      list.push([c.id, n]);
    }
    lengths[c.id] = toks.length;
    total += toks.length;
  }
  return (cached = { chunks, postings, lengths, avgLen: total / Math.max(chunks.length, 1) });
}

export function indexStats() {
  const idx = load();
  if (!idx) return { available: false, chunks: 0, sources: [] as string[] };
  return { available: true, chunks: idx.chunks.length, sources: [...new Set(idx.chunks.map((c) => c.source))] };
}

export function searchDocs(query: string, k = 6, source?: string): DocChunk[] {
  const idx = load();
  if (!idx) return [];
  const K1 = 1.2, B = 0.75, N = idx.chunks.length;
  const scores = new Map<number, number>();
  for (const term of new Set(tokenize(query))) {
    const list = idx.postings.get(term);
    if (!list) continue;
    const idf = Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5));
    for (const [id, tf] of list) {
      const norm = tf + K1 * (1 - B + (B * idx.lengths[id]) / idx.avgLen);
      scores.set(id, (scores.get(id) ?? 0) + (idf * (tf * (K1 + 1))) / norm);
    }
  }
  const wanted = source?.toLowerCase();
  return [...scores.entries()]
    .filter(([id]) => !wanted || idx.chunks[id].source.toLowerCase().includes(wanted))
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id]) => idx.chunks[id]);
}
