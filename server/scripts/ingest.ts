// Builds data/index.json, the RAG corpus searched by the `search_ansible_docs` tool.
//
//   npm run ingest                         # clone docs repos in data/sources.json and index them
//   npm run ingest -- --modules            # also index every installed module/plugin doc (ansible-doc --metadata-dump)
//   npm run ingest -- --local ./aap-docs   # also index your own folder (e.g. AAP docs exported from docs.redhat.com)
//   npm run ingest -- --only ansible-lint  # only the sources whose name matches
//   npm run ingest -- --skip-clone         # reuse what is already in data/raw
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface Source {
  name: string;
  repo: string;
  branch: string;
  dir: string;
  url?: string;
}
interface Chunk {
  id: number;
  source: string;
  title: string;
  url: string;
  text: string;
}

const ROOT = process.cwd();
const RAW = path.join(ROOT, "data", "raw");
const OUT = path.join(ROOT, "data", "index.json");
const MAX_CHARS = 1800;
const EXTS = new Set([".md", ".rst", ".txt", ".html", ".htm"]);

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const localDirs = args.flatMap((a, i) => (a === "--local" && args[i + 1] ? [args[i + 1]] : []));

const chunks: Chunk[] = [];
const push = (source: string, title: string, url: string, text: string) => {
  const t = text.replace(/\n{3,}/g, "\n\n").trim();
  if (t.length > 80) chunks.push({ id: chunks.length, source, title, url, text: t });
};

function git(cwd: string, ...a: string[]) {
  execFileSync("git", a, { cwd, stdio: ["ignore", "ignore", "inherit"] });
}

function clone(s: Source): string {
  const dest = path.join(RAW, `${s.repo}/${s.dir}`.replace(/[/]/g, "__"));
  if (flag("--skip-clone") && fs.existsSync(dest)) return dest;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  console.log(`  cloning ${s.repo}@${s.branch} (${s.dir})`);
  git(dest, "init", "-q");
  git(dest, "remote", "add", "origin", `https://github.com/${s.repo}.git`);
  git(dest, "sparse-checkout", "set", s.dir);
  git(dest, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", s.branch);
  git(dest, "checkout", "-q", "FETCH_HEAD");
  return dest;
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name.startsWith(".") || e.name === "node_modules" ? [] : walk(p);
    return EXTS.has(path.extname(e.name).toLowerCase()) ? [p] : [];
  });
}

function cleanRst(s: string): string {
  return s
    .replace(/^\.\. _[^:]+:\s*$/gm, "")
    .replace(/^\.\. (contents|toctree|index|meta)::[\s\S]*?(?=\n\S|\n*$)/gm, "")
    .replace(/:(ref|doc|term|class|func|meth|ansplugin|ansopt|ansval|ansretval|envvar|file|program|option)`([^`<]*?)\s*(<[^>]+>)?`/g, "$2")
    .replace(/``([^`]+)``/g, "`$1`")
    .replace(/^\.\. code-block::\s*(\w*)/gm, "```$1")
    .replace(/^\.\. (note|warning|important|tip|seealso|versionadded|deprecated|versionchanged)::/gm, (_, k) => `${k.toUpperCase()}:`);
}

function stripHtml(s: string): string {
  return s
    .replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "")}\n`)
    .replace(/<(pre)[^>]*>([\s\S]*?)<\/pre>/gi, (_, __, t) => `\n\`\`\`\n${t.replace(/<[^>]+>/g, "")}\n\`\`\`\n`)
    .replace(/<br\s*\/?>|<\/(p|li|div|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ");
}

/** Splits a document into sections by heading, then packs them into ~MAX_CHARS chunks. */
function sections(text: string, ext: string): Array<{ trail: string; body: string }> {
  const lines = text.split("\n");
  const out: Array<{ trail: string; body: string }> = [];
  const trail: string[] = [];
  const rstLevels: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) out.push({ trail: trail.filter(Boolean).join(" > "), body });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const md = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    const next = lines[i + 1] ?? "";
    const isRst = ext === ".rst" && line.trim() && /^([=\-~^"'`#*+])\1{2,}\s*$/.test(next) && next.trim().length >= line.trim().length - 2;
    if (md && ext !== ".rst") {
      flush();
      const lvl = md[1].length - 1;
      trail.length = lvl;
      trail[lvl] = md[2];
    } else if (isRst) {
      flush();
      const ch = next.trim()[0];
      let lvl = rstLevels.indexOf(ch);
      if (lvl < 0) lvl = rstLevels.push(ch) - 1;
      trail.length = lvl;
      trail[lvl] = line.trim();
      i++;
    } else if (ext === ".rst" && /^([=\-~^"'`#*+])\1{2,}\s*$/.test(line) && /^([=\-~^"'`#*+])\1{2,}\s*$/.test(lines[i + 2] ?? "")) {
      continue; // overline of an over+underlined title; the title line is handled next
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

function pack(source: string, docTitle: string, url: string, text: string, ext: string) {
  for (const { trail, body } of sections(text, ext)) {
    const title = [docTitle, trail].filter(Boolean).join(" > ");
    if (body.length <= MAX_CHARS) {
      push(source, title, url, body);
      continue;
    }
    let cur = "";
    for (const para of body.split(/\n\s*\n/)) {
      if (cur && cur.length + para.length > MAX_CHARS) {
        push(source, title, url, cur);
        cur = cur.slice(-200); // small overlap for context
      }
      cur += (cur ? "\n\n" : "") + para;
    }
    push(source, title, url, cur);
  }
}

function indexFiles(source: string, base: string, files: string[], urlFor: (rel: string) => string) {
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue; // e.g. a symlink to a file outside the sparse checkout
    }
    if (ext === ".rst") text = cleanRst(text);
    if (ext === ".html" || ext === ".htm") text = stripHtml(text);
    const rel = path.relative(base, f);
    const docTitle = rel.replace(/\.(md|rst|txt|html?)$/i, "").replace(/\/index$/, "").replace(/[_/]/g, " ");
    pack(source, docTitle, urlFor(rel), text, ext === ".html" || ext === ".htm" ? ".md" : ext);
  }
}

function indexModules() {
  console.log("  dumping installed plugin docs (ansible-doc --metadata-dump), this can take a few minutes");
  let dump: string;
  try {
    dump = execFileSync("ansible-doc", ["--metadata-dump", "--no-fail-on-errors"], {
      maxBuffer: 2 * 1024 ** 3,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ANSIBLE_DEPRECATION_WARNINGS: "False", ANSIBLE_NOCOLOR: "1" },
    });
  } catch (e) {
    console.warn(`  skipped: ${(e as Error).message.split("\n")[0]}`);
    return;
  }
  const data = JSON.parse(dump).all as Record<string, Record<string, { doc?: Record<string, unknown>; examples?: string; return?: Record<string, unknown> }>>;
  let n = 0;
  for (const [ptype, plugins] of Object.entries(data)) {
    for (const [fqcn, info] of Object.entries(plugins)) {
      const doc = info?.doc as
        | { short_description?: string; description?: string | string[]; options?: Record<string, { description?: string | string[]; type?: string; default?: unknown; choices?: unknown[]; required?: boolean }>; version_added?: string; deprecated?: unknown }
        | undefined;
      if (!doc) continue;
      const desc = Array.isArray(doc.description) ? doc.description.join(" ") : doc.description ?? "";
      const opts = Object.entries(doc.options ?? {})
        .map(([k, o]) => {
          const d = Array.isArray(o.description) ? o.description.join(" ") : o.description ?? "";
          const meta = [o.type && `type=${o.type}`, o.required && "required", o.default !== undefined && `default=${JSON.stringify(o.default)}`, o.choices && `choices=${JSON.stringify(o.choices)}`].filter(Boolean).join(", ");
          return `- ${k} (${meta}): ${d}`;
        })
        .join("\n");
      const [ns, coll] = fqcn.split(".");
      const url = `https://docs.ansible.com/ansible/latest/collections/${ns}/${coll}/${fqcn.split(".").slice(2).join(".")}_${ptype}.html`;
      const header = `${fqcn} (${ptype}) - ${doc.short_description ?? ""}${doc.deprecated ? " [DEPRECATED]" : ""}${doc.version_added ? ` (added in ${doc.version_added})` : ""}\n\n${desc}`;
      pack("module docs", `${fqcn} ${ptype}`, url, `${header}\n\n## Options\n${opts}\n\n## Examples\n${info.examples ?? ""}`, ".md");
      n++;
    }
  }
  console.log(`  indexed ${n} plugins`);
}

function main() {
  fs.mkdirSync(RAW, { recursive: true });
  const { repos } = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "sources.json"), "utf8")) as { repos: Source[] };
  const only = opt("--only")?.toLowerCase();
  for (const s of repos) {
    if (only && !s.name.toLowerCase().includes(only)) continue;
    console.log(`• ${s.name}`);
    try {
      const dest = clone(s);
      const base = path.join(dest, s.dir);
      const before = chunks.length;
      indexFiles(s.name, base, walk(base), (rel) => {
        const noExt = rel.replace(/\.(md|rst|txt)$/i, "");
        return s.url ? s.url.replace("{path}", noExt.replace(/\/?index$/, "")) : `https://github.com/${s.repo}/blob/${s.branch}/${s.dir}/${rel}`;
      });
      console.log(`  ${chunks.length - before} chunks`);
    } catch (e) {
      console.warn(`  failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  for (const dir of localDirs) {
    const abs = path.resolve(dir);
    console.log(`• local: ${abs}`);
    const before = chunks.length;
    indexFiles(path.basename(abs), abs, walk(abs), (rel) => `file://${path.join(abs, rel)}`);
    console.log(`  ${chunks.length - before} chunks`);
  }
  if (flag("--modules")) indexModules();

  fs.writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), chunks }));
  console.log(`\nWrote ${chunks.length} chunks to ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
}

main();
