// Retrieval evaluation: recall@5 (and @1, @10, MRR) for keyword, vector and hybrid search,
// loading the published index exactly as the phone does.
//
//   npm run eval                          uses eval/golden.jsonl, falling back to eval/smoke.jsonl
//   npm run eval -- --set eval/smoke.jsonl --misses
//   npm run eval -- --gate eval/baseline.json   fail if hybrid recall@5 drops > 2 points vs the baseline
//   npm run eval -- --set <golden.jsonl> --subset <pilot_meta.json>   also report recall@5 on the subset's question_ids
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SearchIndex, unpack, type Chunk, type LoadedShard, type Manifest, type ShardMeta } from "../shared/search.ts";
import { OUT_DIR, ROOT } from "./config.ts";
import { embed } from "./embed.ts";

const Golden = z.object({
  id: z.string(),
  question: z.string(),
  expected_chunk_ids: z.array(z.string()).default([]),
  expected_urls: z.array(z.string()).default([]),
  category: z.string().optional(),
});
type Golden = z.infer<typeof Golden>;

const args = process.argv.slice(2);
const val = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

export function loadIndex(dir = OUT_DIR): { index: SearchIndex; manifest: Manifest } {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  const shards: LoadedShard[] = manifest.shards.map((s) => {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, s.meta.path), "utf8")) as ShardMeta;
    const buf = fs.readFileSync(path.join(dir, s.vec.path));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return { meta, ...unpack(ab, meta.rows.length, meta.dims) };
  });
  return { index: new SearchIndex(shards), manifest };
}

const normUrl = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();

function isHit(c: Chunk, g: Golden): boolean {
  if (g.expected_chunk_ids.includes(c.id)) return true;
  const u = normUrl(c.u);
  return g.expected_urls.some((e) => u === normUrl(e) || u.endsWith(normUrl(e).replace(/^https?:\/\/[^/]+/, "")));
}

async function main() {
  const setPath = val("--set") ?? (fs.existsSync(path.join(ROOT, "eval/golden.jsonl")) ? "eval/golden.jsonl" : "eval/smoke.jsonl");
  const golden = fs
    .readFileSync(path.resolve(ROOT, setPath), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => Golden.parse(JSON.parse(l)));
  const { index, manifest } = loadIndex();
  console.log(`set: ${setPath} (${golden.length} questions)`);
  console.log(`index: ${manifest.stats.chunks} chunks, ${manifest.stats.rows} vectors, ${(manifest.stats.bytes / 1e6).toFixed(1)} MB, ${manifest.stats.enriched} enriched`);

  const qv = await embed(golden.map((g) => g.question), { query: true });
  const modes = {
    keyword: (i: number) => index.keyword(golden[i].question, 10).map(([c]) => index.chunks[c]),
    vector: (i: number) => index.vector(qv[i], 10).map(([c]) => index.chunks[c]),
    hybrid: (i: number) => index.hybrid(golden[i].question, qv[i], 10).map((r) => r.chunk),
  };

  const subsetPath = val("--subset");
  const subset = subsetPath ? new Set<string>(JSON.parse(fs.readFileSync(path.resolve(subsetPath), "utf8")).question_ids) : null;
  const report: Record<string, Record<string, number>> = {};
  const misses: string[] = [];
  for (const [mode, run] of Object.entries(modes)) {
    let r1 = 0, r5 = 0, r10 = 0, mrr = 0, s5 = 0, sn = 0;
    const byCat: Record<string, [number, number]> = {};
    golden.forEach((g, i) => {
      const res = run(i);
      const rank = res.findIndex((c) => isHit(c, g));
      if (rank === 0) r1++;
      if (rank >= 0 && rank < 5) r5++;
      if (subset?.has(g.id)) (sn++, rank >= 0 && rank < 5 && s5++);
      if (rank >= 0) (r10++, (mrr += 1 / (rank + 1)));
      const cat = g.category ?? "all";
      byCat[cat] ??= [0, 0];
      byCat[cat][1]++;
      if (rank >= 0 && rank < 5) byCat[cat][0]++;
      if (mode === "hybrid" && (rank < 0 || rank >= 5)) misses.push(`${g.id}: ${g.question}\n    want ${g.expected_urls.join(", ")}\n    got  ${res.slice(0, 3).map((c) => c.u.replace("https://docs.ansible.com/ansible/latest/", "")).join(" | ")}`);
    });
    const n = golden.length;
    report[mode] = { "recall@1": r1 / n, "recall@5": r5 / n, "recall@10": r10 / n, mrr: mrr / n, ...(subset ? { "subset_recall@5": s5 / Math.max(sn, 1), subset_n: sn } : {}) };
    console.log(
      `${mode.padEnd(8)} recall@1 ${(100 * r1 / n).toFixed(1).padStart(5)}%  recall@5 ${(100 * r5 / n).toFixed(1).padStart(5)}%  recall@10 ${(100 * r10 / n).toFixed(1).padStart(5)}%  MRR ${(mrr / n).toFixed(3)}` +
        (subset ? `  subset recall@5 ${s5}/${sn} (${(100 * s5 / Math.max(sn, 1)).toFixed(1)}%)` : "") +
        (Object.keys(byCat).length > 1 ? `\n         by category: ${Object.entries(byCat).map(([k, [h, t]]) => `${k} ${h}/${t}`).join(", ")}` : ""),
    );
  }
  if (args.includes("--misses")) console.log(`\nhybrid misses at 5:\n  ${misses.join("\n  ")}`);

  const out = { set: setPath, questions: golden.length, built_at: manifest.built_at, index: manifest.stats, report };
  fs.mkdirSync(path.join(ROOT, "eval"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "eval", val("--out") ?? "last-run.json"), JSON.stringify(out, null, 2) + "\n");

  const gate = val("--gate");
  if (gate) {
    const base = JSON.parse(fs.readFileSync(path.resolve(ROOT, gate), "utf8"));
    const drop = base.report.hybrid["recall@5"] - report.hybrid["recall@5"];
    if (drop > 0.02) {
      console.error(`GATE FAILED: hybrid recall@5 dropped ${(drop * 100).toFixed(1)} points vs ${gate}`);
      process.exit(1);
    }
    console.log(`gate passed (change ${(-drop * 100).toFixed(1)} points)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
