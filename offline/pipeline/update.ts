// Nightly docs update (phase 3): follow the upstream branches, re-chunk only when something moved,
// and work out which chunks need enrichment. Unchanged chunk ids keep their enrichment files and
// cached vectors, so only new or changed passages need new enrichment.
//
//   npm run update                    check upstream; if a branch head or the ansible-core release moved,
//                                     re-chunk at the new commits, move the pins in sources.lock.json,
//                                     delete orphaned enrichment files, write pending-enrichment.jsonl
//   npm run update -- --no-fetch      only recompute pending-enrichment.jsonl from the committed chunks
//                                     (run it after writing enrichment files; deletes the file when nothing is left)
//   npm run update -- --enrich-api    also enrich the pending chunks through the Batch API (needs ANTHROPIC_API_KEY)
//   npm run update -- --force         re-chunk even when no pin moved
//   npm run update -- --base origin/main   report the delta against a git ref instead of the files on disk
//
// Writes work/update-report.md (the PR body) and, under GitHub Actions, the step outputs
// `updated` (pins moved), `pending` (chunks without enrichment) and `pruned` (orphans deleted).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ansibleCoreVersion, remoteHead } from "./fetch.ts";
import { LOCK_FILE, readLock, ROOT, SOURCES, WORK_DIR, type SourcesLock } from "./config.ts";
import { diffChunks, needsEnrichment, orphans, parseJsonl, type ChunkLine, type Delta } from "./delta.ts";
import { enrich, ENRICH_DIR } from "./enrich.ts";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

const CHUNK_DIR = path.join(ROOT, "chunks");
const PENDING_FILE = path.join(ROOT, "pending-enrichment.jsonl");
const REPORT_FILE = path.join(WORK_DIR, "update-report.md");
const REPO_ROOT = path.resolve(ROOT, "..");
const REL = path.relative(REPO_ROOT, ROOT); // "offline"

type PendingLine = ChunkLine & { change: "changed" | "added"; previous_chunk_id?: string; previous_enrichment?: unknown };

const listFiles = () => fs.readdirSync(CHUNK_DIR).filter((f) => f.endsWith(".jsonl")).sort();
const readChunksOnDisk = (): ChunkLine[] => listFiles().flatMap((f) => parseJsonl(fs.readFileSync(path.join(CHUNK_DIR, f), "utf8")));
const enrichedIds = () => new Set(fs.readdirSync(ENRICH_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));

function gitShow(ref: string, rel: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${REL}/${rel}`], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
function readChunksAt(ref: string): ChunkLine[] {
  const names = execFileSync("git", ["ls-tree", "--name-only", `${ref}:${REL}/chunks`], { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".jsonl"));
  return names.flatMap((f) => parseJsonl(gitShow(ref, `chunks/${f}`) ?? ""));
}

function setOutput(name: string, value: string | number | boolean) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const base = val("--base");
  const lock = readLock();
  // Enrichment of chunks that are replaced, read before orphans are deleted (the new passage often keeps most of it).
  const oldEnrichment = (id: string): unknown => {
    const f = path.join(ENRICH_DIR, `${id}.json`);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
    const s = base ? gitShow(base, `enrichment/${id}.json`) : null;
    return s ? JSON.parse(s) : undefined;
  };
  const oldCache = new Map<string, unknown>();

  let moved: Array<{ repo: string; branch: string; from: string; to: string }> = [];
  let coreMoved: { from: string; to: string } | null = null;
  let delta: Delta | null = null;
  const before = base ? readChunksAt(base) : readChunksOnDisk();

  if (!has("--no-fetch")) {
    console.log("checking upstream");
    const heads = SOURCES.map((s) => ({ repo: s.repo, branch: s.branch, from: lock.sources[s.repo]?.commit ?? "", to: remoteHead(s.repo, s.branch) }));
    for (const h of heads) console.log(`  ${h.repo}@${h.branch}: locked ${h.from.slice(0, 10) || "(none)"}, head ${h.to.slice(0, 10)}`);
    const core = ansibleCoreVersion();
    console.log(`  ansible-core: locked ${lock.ansible_core || "(none)"}, installed ${core}`);
    moved = heads.filter((h) => h.from !== h.to);
    if (lock.ansible_core !== core) coreMoved = { from: lock.ansible_core, to: core };

    if (moved.length || coreMoved || has("--force")) {
      console.log("re-chunking at the new commits");
      const env = { ...process.env };
      for (const h of heads) {
        if (h.repo === "ansible/ansible-documentation") env.CORE_REF = h.to;
        if (h.repo === "ansible/aap-docs") env.AAP_REF = h.to;
      }
      execFileSync(process.execPath, ["--import", "tsx", "pipeline/build.ts", "--chunks-only"], { cwd: ROOT, env, stdio: "inherit" });
      const after = readChunksOnDisk();
      delta = diffChunks(before, after);
      for (const c of delta.changed) oldCache.set(c.id, oldEnrichment(c.previous));
      const next: SourcesLock = { ...lock, sources: Object.fromEntries(heads.map((h) => [h.repo, { branch: h.branch, commit: h.to }])), ansible_core: core };
      fs.writeFileSync(LOCK_FILE, JSON.stringify(next, null, 2) + "\n");
    } else console.log("  no upstream change");
  } else if (base) {
    delta = diffChunks(before, readChunksOnDisk());
  }

  // Orphaned enrichment (its chunk changed or went away) is deleted; git history keeps it.
  const chunks = readChunksOnDisk();
  const pruned = orphans(chunks, enrichedIds());
  for (const id of pruned) fs.rmSync(path.join(ENRICH_DIR, `${id}.json`));

  // Pending list: chunks with no enrichment file. Earlier "changed" notes are carried over.
  const carried = new Map<string, PendingLine>();
  if (fs.existsSync(PENDING_FILE)) for (const l of parseJsonl(fs.readFileSync(PENDING_FILE, "utf8")) as PendingLine[]) carried.set(l.chunk_id, l);
  const changedFrom = new Map((delta?.changed ?? []).map((c) => [c.id, c.previous]));
  let pending: PendingLine[] = needsEnrichment(chunks, enrichedIds()).map((c) => {
    const prev = changedFrom.get(c.chunk_id) ?? carried.get(c.chunk_id)?.previous_chunk_id;
    const prevEnrichment = oldCache.get(c.chunk_id) ?? carried.get(c.chunk_id)?.previous_enrichment;
    return { ...c, change: prev ? "changed" : "added", ...(prev ? { previous_chunk_id: prev } : {}), ...(prevEnrichment ? { previous_enrichment: prevEnrichment } : {}) };
  });

  if (has("--enrich-api") && pending.length) {
    console.log(`enriching ${pending.length} pending chunks through the Batch API`);
    await enrich(
      pending.map((c) => ({ id: c.chunk_id, t: c.headings.join(" > "), u: c.url, x: c.text, src: c.source, lic: c.licence, ...(c.fqcn ? { fq: c.fqcn } : {}) })),
      { writeFiles: true },
    );
    const done = enrichedIds();
    pending = pending.filter((c) => !done.has(c.chunk_id));
  }

  if (pending.length) fs.writeFileSync(PENDING_FILE, pending.map((c) => JSON.stringify(c)).join("\n") + "\n");
  else fs.rmSync(PENDING_FILE, { force: true });

  const report = renderReport({ moved, coreMoved, delta, pruned, pending, total: chunks.length, base });
  fs.writeFileSync(REPORT_FILE, report);
  console.log(`\n${report}`);
  setOutput("updated", moved.length > 0 || coreMoved !== null);
  setOutput("pending", pending.length);
  setOutput("pruned", pruned.length);
}

function renderReport(r: {
  moved: Array<{ repo: string; branch: string; from: string; to: string }>;
  coreMoved: { from: string; to: string } | null;
  delta: Delta | null;
  pruned: string[];
  pending: PendingLine[];
  total: number;
  base?: string;
}): string {
  const out: string[] = [];
  out.push("## Upstream");
  if (!r.moved.length && !r.coreMoved) out.push("No upstream change since the pins in `offline/sources.lock.json`.");
  for (const m of r.moved) out.push(`- \`${m.repo}\` (${m.branch}): [${m.from.slice(0, 10) || "unpinned"} → ${m.to.slice(0, 10)}](https://github.com/${m.repo}/compare/${m.from}...${m.to})`);
  if (r.coreMoved) out.push(`- \`ansible-core\` (plugin docs): ${r.coreMoved.from || "unpinned"} → ${r.coreMoved.to}`);
  if (r.delta) {
    const d = r.delta;
    out.push("", `## Chunks${r.base ? ` (compared with \`${r.base}\`)` : ""}`, "", "| | |", "|---|---|");
    out.push(`| Unchanged (enrichment and vectors reused) | ${d.unchanged.length} |`, `| Changed | ${d.changed.length} |`, `| New | ${d.added.length} |`, `| Removed | ${d.removed.length} |`, `| Total now | ${r.total} |`);
  }
  if (r.pruned.length) out.push("", `Deleted ${r.pruned.length} orphaned enrichment files (their chunk changed or was removed).`);
  out.push("", "## Enrichment");
  if (!r.pending.length) out.push("Every chunk has an enrichment file. This is ready to merge once CI is green; merging rebuilds the index.");
  else {
    const changed = r.pending.filter((p) => p.change === "changed").length;
    out.push(
      `**${r.pending.length} chunks need enrichment** (${changed} changed, ${r.pending.length - changed} new). They are listed in \`offline/pending-enrichment.jsonl\`, one chunk per line in the same format as \`chunks/*.jsonl\`. A changed chunk also carries \`previous_enrichment\`, the enrichment of the passage it replaced, to update rather than rewrite.`,
      "",
      "To enrich them (a Claude thread, or anyone): check out this branch, and for each line write `offline/enrichment/<chunk_id>.json` in the format in `offline/README.md` (summary, 3 to 5 questions, optional answer card whose `source_url` is the chunk's `url`). Then run `npm run update -- --no-fetch` (drops the finished lines, deletes the file when none are left) and `npm run check:enrichment`, and push to this branch.",
      "",
      "<details><summary>Pending chunk ids</summary>",
      "",
      ...r.pending.slice(0, 400).map((p) => `- \`${p.chunk_id}\` ${p.change}${p.previous_chunk_id ? ` (was \`${p.previous_chunk_id}\`)` : ""}: ${p.headings.join(" > ").slice(0, 120)}`),
      ...(r.pending.length > 400 ? [`- … and ${r.pending.length - 400} more in the file`] : []),
      "",
      "</details>",
    );
  }
  return out.join("\n") + "\n";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
