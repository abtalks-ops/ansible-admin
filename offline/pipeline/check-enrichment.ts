// Checks that the committed chunk lists and enrichment files agree:
//   every chunk in chunks/*.jsonl has exactly one valid enrichment/<chunk_hash>.json,
//   no enrichment file is orphaned, ids are unique across products, answer cards cite their
//   chunk's URL, and no URL keeps an unresolved AsciiDoc attribute such as {context}.
//
//   npm run check:enrichment
// Exits 1 on any problem. Needs no network, API key or model.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.ts";
import { ENRICH_DIR, EnrichmentFile } from "./enrich.ts";

const problems: string[] = [];
const chunkDir = path.join(ROOT, "chunks");
const urls = new Map<string, string>(); // chunk id -> url
for (const f of fs.readdirSync(chunkDir).filter((x) => x.endsWith(".jsonl")).sort()) {
  let n = 0;
  for (const line of fs.readFileSync(path.join(chunkDir, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const c = JSON.parse(line) as { chunk_id: string; chunk_hash: string; url: string };
    n++;
    if (c.chunk_id !== c.chunk_hash) problems.push(`${f}: ${c.chunk_id} has chunk_hash ${c.chunk_hash}`);
    if (urls.has(c.chunk_id)) problems.push(`${f}: duplicate chunk id ${c.chunk_id}`);
    if (/\{[\w-]+\}/.test(c.url)) problems.push(`${f}: ${c.chunk_id} url has an unresolved attribute: ${c.url}`);
    urls.set(c.chunk_id, c.url);
  }
  console.log(`${f}: ${n} chunks`);
}

const files = fs.readdirSync(ENRICH_DIR).filter((x) => x.endsWith(".json"));
let cards = 0;
let droppedCards = 0; // too short to show; the build drops them too
const covered = new Set<string>();
for (const f of files) {
  const id = f.slice(0, -".json".length);
  const raw = JSON.parse(fs.readFileSync(path.join(ENRICH_DIR, f), "utf8"));
  let p = EnrichmentFile.safeParse(raw);
  // Same rule as the build: an invalid card is dropped and the summary and questions still count.
  if (!p.success && p.error.issues.every((i) => i.path[0] === "answer_card")) {
    droppedCards++;
    p = EnrichmentFile.safeParse({ ...raw, answer_card: null });
  }
  if (!p.success) {
    problems.push(`${f}: ${p.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    continue;
  }
  if (p.data.chunk_hash !== id || p.data.chunk_id !== id) problems.push(`${f}: chunk_id/chunk_hash do not match the file name`);
  if (!urls.has(id)) {
    problems.push(`${f}: orphaned, no chunk with this id in chunks/`);
    continue;
  }
  covered.add(id);
  if (p.data.answer_card) {
    cards++;
    if (p.data.answer_card.source_url !== urls.get(id)) problems.push(`${f}: answer card cites ${p.data.answer_card.source_url}, chunk url is ${urls.get(id)}`);
  }
}
for (const id of urls.keys()) if (!covered.has(id)) problems.push(`missing enrichment for chunk ${id}`);

console.log(`${files.length} enrichment files, ${covered.size} of ${urls.size} chunks covered, ${cards} answer cards (${droppedCards} invalid cards dropped, as the build does)`);
if (problems.length) {
  for (const p of problems.slice(0, 50)) console.error(`  ${p}`);
  if (problems.length > 50) console.error(`  ... and ${problems.length - 50} more`);
  console.error(`FAILED: ${problems.length} problems`);
  process.exit(1);
}
console.log("enrichment check passed");
