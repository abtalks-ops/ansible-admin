// Builds the on-device index: fetch -> normalize/chunk/tag -> enrich -> embed -> quantize -> shards + manifest.
//
//   npm run build:index                 full build
//   npm run build:index -- --reuse      reuse existing checkouts in raw/
//   npm run build:index -- --enrich-api  also run Opus enrichment through the Batch API (needs ANTHROPIC_API_KEY)
//   npm run build:index -- --enrich-api --enrich-limit 200   pilot on a sample first, to check cost and quality
// Enrichment files in enrichment/<chunk_hash>.json are always applied, however they were written.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { INDEX_FORMAT, quantize, type Chunk, type Manifest, type ShardFile, type ShardMeta } from "../shared/search.ts";
import { chunkBuiltinPlugins, chunkRepo } from "./chunk.ts";
import { EMBEDDER, OUT_DIR, PRODUCT, ROOT, SHARD_MAX_CHUNKS, SOURCES, VERSION, WORK_DIR } from "./config.ts";
import { embed, passageText } from "./embed.ts";
import { applyCachedEnrichment, enrich } from "./enrich.ts";
import { fetchSource } from "./fetch.ts";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// ---------- embedding cache: unchanged rows keep their vectors across builds ----------
const EMB_CACHE = path.join(WORK_DIR, `embed-cache.${EMBEDDER.id.replace("/", "__")}.${EMBEDDER.dtype}.json`);
function loadEmbCache(): Map<string, Float32Array> {
  if (!fs.existsSync(EMB_CACHE)) return new Map();
  const obj = JSON.parse(fs.readFileSync(EMB_CACHE, "utf8")) as Record<string, string>;
  return new Map(Object.entries(obj).map(([k, b64]) => [k, new Float32Array(new Uint8Array(Buffer.from(b64, "base64")).buffer)]));
}
function saveEmbCache(m: Map<string, Float32Array>) {
  const obj: Record<string, string> = {};
  for (const [k, v] of m) obj[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
  fs.writeFileSync(EMB_CACHE, JSON.stringify(obj));
}

/** Extra vector rows: each generated question, and the answer card title, embedded like a query. */
function extraKeys(c: Chunk): Array<{ key: string; text: string }> {
  const qs = [...(c.qs ?? []), ...(c.card ? [c.card.title] : [])];
  return qs.map((q, i) => ({ key: `${c.id}:q${i}:${sha(q).slice(0, 8)}`, text: EMBEDDER.query_prefix + q }));
}

function writeFile(name: string, ext: string, data: Buffer): ShardFile {
  const h = sha(data);
  const file = `${name}.${h.slice(0, 12)}.${ext}`;
  fs.writeFileSync(path.join(OUT_DIR, file), data);
  return { path: file, sha256: h, bytes: data.length };
}

/** chunks/<product>-<version>.jsonl: the chunk list other steps (golden set, enrichment) refer to by id. */
function exportChunks(all: Chunk[]) {
  const dir = path.join(ROOT, "chunks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${PRODUCT}-${VERSION}.jsonl`);
  fs.writeFileSync(
    file,
    all.map((c) => JSON.stringify({ chunk_id: c.id, chunk_hash: c.id, source: c.src, url: c.u, headings: c.t.split(" > "), fqcn: c.fq ?? null, licence: c.lic, text: c.x })).join("\n") + "\n",
  );
  console.log(`  wrote ${path.relative(ROOT, file)}`);
}

async function main() {
  const t0 = Date.now();
  fs.mkdirSync(WORK_DIR, { recursive: true });

  console.log("1-4. fetch, normalize, chunk, tag");
  const groups: Array<{ name: string; chunks: Chunk[] }> = [];
  for (const s of SOURCES) {
    const { dir, sha: commit } = fetchSource(s, has("--reuse"));
    const chunks = chunkRepo(s, dir);
    console.log(`  ${s.name} @ ${s.ref} (${commit.slice(0, 10)}): ${chunks.length} chunks`);
    groups.push({ name: "docs", chunks });
  }
  const plugins = chunkBuiltinPlugins();
  console.log(`  ansible.builtin plugin docs: ${plugins.length} chunks`);
  groups.push({ name: "plugins", chunks: plugins });
  const all = groups.flatMap((g) => g.chunks);
  exportChunks(all);

  console.log("5. enrich");
  if (has("--enrich-api")) await enrich(all, { limit: val("--enrich-limit") ? Number(val("--enrich-limit")) : undefined });
  else console.log("  Batch API enrichment not requested (pass --enrich-api); applying enrichment/ files");
  const enriched = applyCachedEnrichment(all);
  console.log(`  ${enriched} of ${all.length} chunks carry enrichment`);

  console.log("6. embed");
  // One row per chunk text, plus one per generated question (better matching of how people ask).
  const rowsText: Array<{ key: string; text: string }> = [];
  for (const c of all) {
    rowsText.push({ key: `${c.id}:p`, text: passageText(c.t, c.x) });
    for (const key of extraKeys(c)) rowsText.push(key);
  }
  const cache = loadEmbCache();
  const missing = rowsText.filter((r) => !cache.has(r.key));
  console.log(`  ${rowsText.length} rows, ${rowsText.length - missing.length} cached, embedding ${missing.length}`);
  let last = 0;
  const vecs = await embed(missing.map((r) => r.text), {
    onProgress: (d) => {
      if (d - last >= 500 || d === missing.length) {
        console.log(`  ${d}/${missing.length}`);
        last = d;
      }
    },
  });
  missing.forEach((r, i) => cache.set(r.key, vecs[i]));
  saveEmbCache(cache);

  console.log("7. quantize and package");
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest: Manifest = {
    index_format: INDEX_FORMAT,
    built_at: new Date().toISOString(),
    embedder: { ...EMBEDDER },
    shards: [],
    stats: { chunks: all.length, rows: 0, bytes: 0, enriched },
  };
  for (const g of groups) {
    for (let start = 0, part = 1; start < g.chunks.length; start += SHARD_MAX_CHUNKS, part++) {
      const chunks = g.chunks.slice(start, start + SHARD_MAX_CHUNKS);
      const id = `${PRODUCT}-${VERSION}-${g.name}-${part}`;
      const rows: number[] = [];
      const rowVecs: Float32Array[] = [];
      chunks.forEach((c, ci) => {
        for (const key of [`${c.id}:p`, ...extraKeys(c).map((r) => r.key)]) {
          rows.push(ci);
          rowVecs.push(cache.get(key)!);
        }
      });
      const meta: ShardMeta = { format: INDEX_FORMAT, shard: id, product: PRODUCT, version: VERSION, dims: EMBEDDER.dims, chunks, rows };
      const metaFile = writeFile(id, "json", Buffer.from(JSON.stringify(meta)));
      const vecFile = writeFile(id, "vec", Buffer.from(quantize(rowVecs, EMBEDDER.dims)));
      manifest.shards.push({ id, product: PRODUCT, version: VERSION, chunks: chunks.length, rows: rows.length, meta: metaFile, vec: vecFile });
      manifest.stats.rows += rows.length;
      manifest.stats.bytes += metaFile.bytes + vecFile.bytes;
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\n8. done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${manifest.shards.length} shards, ${all.length} chunks, ${manifest.stats.rows} vectors, ${(manifest.stats.bytes / 1e6).toFixed(1)} MB in ${path.relative(process.cwd(), OUT_DIR)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
