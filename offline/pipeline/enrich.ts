// Step 5: enrich with Opus 5.5 through the Message Batches API (50% cheaper, async).
// For each chunk, Opus writes a two-line summary and 3-5 questions the chunk answers.
// Results are cached by chunk id (a content hash), so later runs only pay for new or
// changed chunks. Skipped, with a notice, when no API key is configured.
//
// Answer cards (vetted answers for the most-asked topics) are phase 2: they need the
// golden set and usage data to pick topics, so they are not generated here yet.
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Chunk } from "../shared/search.ts";
import { ENRICH_MODEL, ROOT, WORK_DIR } from "./config.ts";

const CACHE = path.join(WORK_DIR, "enrich-cache.jsonl");
/** Enrichment written outside the API (e.g. with a Claude subscription), one file per chunk, committed to the repo. */
export const ENRICH_DIR = path.join(ROOT, "enrichment");

const Enrichment = z.object({
  summary: z.string().min(10).max(600),
  questions: z.array(z.string().min(5).max(300)).min(1).max(8),
  answer_card: z.object({ title: z.string().min(3), answer_md: z.string().min(20), source_url: z.string().url() }).nullish(),
});

/** enrichment/<chunk_hash>.json */
export const EnrichmentFile = Enrichment.extend({
  chunk_id: z.string(),
  chunk_hash: z.string(),
  model: z.string().optional(),
  created_at: z.string().optional(),
});
type Enrichment = z.infer<typeof Enrichment>;

const SYSTEM = `You index Ansible documentation for a retrieval system used by Ansible administrators.
For the passage you are given, return JSON with:
- "summary": at most two sentences saying what the passage tells an administrator, naming exact modules, options, keywords or settings it covers.
- "questions": 3 to 5 distinct questions an administrator might type that this passage answers. Phrase them the way people actually ask (short, specific, sometimes with an error message or a module name). Do not invent facts that are not in the passage.`;

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "questions"],
  additionalProperties: false,
};

function loadFiles(m: Map<string, Enrichment>) {
  if (!fs.existsSync(ENRICH_DIR)) return;
  for (const f of fs.readdirSync(ENRICH_DIR)) {
    if (!f.endsWith(".json")) continue;
    const raw = JSON.parse(fs.readFileSync(path.join(ENRICH_DIR, f), "utf8"));
    let p = EnrichmentFile.safeParse(raw);
    // A card that fails validation (for example a one-line answer) is dropped; the summary and questions still count.
    if (!p.success && p.error.issues.every((i) => i.path[0] === "answer_card")) p = EnrichmentFile.safeParse({ ...raw, answer_card: null });
    if (!p.success) {
      console.warn(`  ignoring ${f}: ${p.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      continue;
    }
    // The chunk id is a content hash, so a file for an older version of a chunk simply stops matching.
    m.set(p.data.chunk_hash, p.data);
  }
}

function loadCache(): Map<string, Enrichment> {
  const m = new Map<string, Enrichment>();
  loadFiles(m);
  if (!fs.existsSync(CACHE)) return m;
  for (const line of fs.readFileSync(CACHE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const { id, ...rest } = JSON.parse(line);
    const p = Enrichment.safeParse(rest);
    if (p.success) m.set(id, p.data);
  }
  return m;
}

export function applyCachedEnrichment(chunks: Chunk[]): number {
  const cache = loadCache();
  let n = 0;
  for (const c of chunks) {
    const e = cache.get(c.id);
    if (e) {
      c.sum = e.summary;
      c.qs = e.questions;
      if (e.answer_card) c.card = e.answer_card;
      n++;
    }
  }
  return n;
}

export async function enrich(chunks: Chunk[], opts: { limit?: number } = {}): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log("  skipped: no ANTHROPIC_API_KEY set (the index is built without summaries and questions)");
    return;
  }
  const cache = loadCache();
  let todo = chunks.filter((c) => !cache.has(c.id));
  if (opts.limit) todo = todo.slice(0, opts.limit);
  if (!todo.length) return console.log("  all chunks already enriched");
  console.log(`  submitting ${todo.length} chunks to the Batch API (${ENRICH_MODEL})`);

  const client = new Anthropic();
  const batch = await client.messages.batches.create({
    requests: todo.map((c) => ({
      custom_id: c.id,
      params: {
        model: ENRICH_MODEL,
        max_tokens: 2000,
        // Low effort: this is extraction, not reasoning, and it runs over thousands of chunks.
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        // The shared system prompt is cached across requests in the batch.
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `Source: ${c.src}\nSection: ${c.t}\n\n${c.x}` }],
      },
    })),
  });
  console.log(`  batch ${batch.id} submitted; polling every 60s (most batches finish within an hour)`);

  let status = batch;
  while (status.processing_status !== "ended") {
    await new Promise((r) => setTimeout(r, 60_000));
    status = await client.messages.batches.retrieve(batch.id);
    console.log(`  ${status.processing_status}: ${status.request_counts.succeeded} done, ${status.request_counts.processing} processing`);
  }

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const out = fs.createWriteStream(CACHE, { flags: "a" });
  let ok = 0, bad = 0;
  const usage = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
  for await (const r of await client.messages.batches.results(batch.id)) {
    if (r.result.type !== "succeeded" || r.result.message.stop_reason !== "end_turn") {
      bad++;
      continue;
    }
    const u = r.result.message.usage;
    usage.input += u.input_tokens;
    usage.cache_read += u.cache_read_input_tokens ?? 0;
    usage.cache_write += u.cache_creation_input_tokens ?? 0;
    usage.output += u.output_tokens;
    const text = r.result.message.content.find((b) => b.type === "text");
    const parsed = text?.type === "text" ? Enrichment.safeParse(JSON.parse(text.text)) : null;
    if (!parsed?.success) {
      bad++;
      continue;
    }
    out.write(JSON.stringify({ id: r.custom_id, ...parsed.data }) + "\n");
    ok++;
  }
  out.end();
  console.log(`  enriched ${ok} chunks, ${bad} failed (failed ones are retried on the next run)`);
  // Batch pricing is half the standard rate; see the pricing page for current per-token prices.
  console.log(`  tokens: input ${usage.input}, cache read ${usage.cache_read}, cache write ${usage.cache_write}, output ${usage.output}; per chunk: ${((usage.input + usage.cache_read + usage.cache_write) / Math.max(ok, 1)).toFixed(0)} in / ${(usage.output / Math.max(ok, 1)).toFixed(0)} out`);
}
