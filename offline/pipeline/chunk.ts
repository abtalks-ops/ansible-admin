// Steps 2-4: normalize (RST -> Markdown-ish text), chunk on headings, tag with metadata.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Chunk } from "../shared/search.ts";
import { CHUNK_MAX_CHARS, CHUNK_MIN_CHARS, SKIP_DIRS, VERSION, type RepoSource } from "./config.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name.startsWith(".") ? [] : walk(p);
    return /\.(rst|md)$/i.test(e.name) ? [p] : [];
  });
}

// ---------- normalize ----------

export function normalizeRst(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Directives whose body is noise: toctrees, labels, meta, raw html, images.
    if (/^\.\. (toctree|contents|meta|raw|image|figure|index|include|literalinclude|_[^:]+:)/.test(line) || /^\.\. _[^:]+:\s*$/.test(line)) {
      while (i + 1 < lines.length && (lines[i + 1].trim() === "" || /^\s+/.test(lines[i + 1]))) i++;
      continue;
    }
    // Code blocks: keep the body intact as a fenced block.
    const code = /^(\s*)\.\. (code-block|code|sourcecode)::\s*(\S*)/.exec(line) ?? (/::\s*$/.test(line) && !/^\s*\.\./.test(line) ? [line, "", "", ""] : null);
    if (code) {
      // Literal-block form ("Example::"): keep the sentence, end it with one colon.
      if (!code[2]) out.push(line.replace(/::\s*$/, ":"));
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*:\w[\w-]*:/.test(lines[j])) j++; // directive options
      while (j < lines.length && (lines[j].trim() === "" || /^\s+/.test(lines[j]))) body.push(lines[j++]);
      const trimmed = dedent(body).trim();
      if (trimmed) out.push("```" + (code[3] ?? ""), trimmed, "```");
      i = j - 1;
      continue;
    }
    out.push(
      line
        .replace(/:(ref|doc|term|class|func|meth|ansplugin|ansopt|ansval|ansretval|envvar|file|program|option|kbd|abbr):`([^`<]*?)\s*(<[^>]+>)?`/g, (_, _r, text, target) => text || (target ?? "").replace(/[<>]/g, ""))
        .replace(/`([^`<]+?)\s*<[^>]+>`_+/g, "$1")
        .replace(/``([^`]+)``/g, "`$1`")
        .replace(/^\.\. (note|warning|important|tip|seealso|caution|attention|versionadded|versionchanged|deprecated)::\s*/, (_, k) => `${k.toUpperCase()}: `),
    );
  }
  return out.join("\n");
}

function dedent(lines: string[]): string {
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  return lines.map((l) => l.slice(Number.isFinite(ind) ? ind : 0)).join("\n");
}

// ---------- chunk ----------

const UNDERLINE = /^([=\-~^"'`#*+])\1{2,}\s*$/;

function sections(text: string, md: boolean): Array<{ trail: string[]; body: string }> {
  const lines = text.split("\n");
  const out: Array<{ trail: string[]; body: string }> = [];
  const trail: string[] = [];
  const levels: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) out.push({ trail: trail.filter(Boolean), body });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) {
      buf.push(line);
      continue;
    }
    const h = md ? /^(#{1,4})\s+(.+?)\s*#*$/.exec(line) : null;
    if (h) {
      flush();
      trail.length = h[1].length - 1;
      trail[h[1].length - 1] = h[2];
      continue;
    }
    if (!md && UNDERLINE.test(line) && UNDERLINE.test(lines[i + 2] ?? "") && lines[i + 1]?.trim()) continue; // overline
    const next = lines[i + 1] ?? "";
    if (!md && line.trim() && UNDERLINE.test(next) && next.trim().length >= line.trim().length - 1) {
      flush();
      const key = (UNDERLINE.test(lines[i - 1] ?? "") ? "o" : "u") + next.trim()[0];
      let lvl = levels.indexOf(key);
      if (lvl < 0) lvl = levels.push(key) - 1;
      trail.length = lvl;
      trail[lvl] = line.trim();
      i++;
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** Packs a section into chunks of at most CHUNK_MAX_CHARS, splitting on paragraphs and never inside a code fence. */
export function pack(body: string): string[] {
  if (body.length <= CHUNK_MAX_CHARS) return [body];
  const paras: string[] = [];
  let cur: string[] = [];
  let fence = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) fence = !fence;
    if (!fence && line.trim() === "" && cur.length) {
      paras.push(cur.join("\n"));
      cur = [];
    } else cur.push(line);
  }
  if (cur.length) paras.push(cur.join("\n"));
  const out: string[] = [];
  let acc = "";
  for (const p of paras) {
    if (acc && acc.length + p.length + 2 > CHUNK_MAX_CHARS) {
      out.push(acc);
      acc = "";
    }
    acc = acc ? `${acc}\n\n${p}` : p;
    // A single huge paragraph or code block is cut hard as a last resort.
    while (acc.length > CHUNK_MAX_CHARS * 1.5) {
      out.push(acc.slice(0, CHUNK_MAX_CHARS));
      acc = acc.slice(CHUNK_MAX_CHARS);
    }
  }
  if (acc) out.push(acc);
  return out;
}

function prettyPath(rel: string): string {
  const parts = rel.replace(/\.(rst|md)$/, "").split("/");
  return parts.map((p) => p.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())).join(" > ");
}

export function chunkRepo(s: RepoSource, dir: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (const file of walk(dir).sort()) {
    const rel = path.relative(dir, file);
    if (SKIP_DIRS.some((d) => rel.startsWith(d))) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const md = file.endsWith(".md");
    if (!md) text = normalizeRst(text);
    for (const { trail, body } of sections(text, md)) {
      // The first heading is the page title; prefix the folder for context.
      const title = [prettyPath(path.dirname(rel)), ...trail].filter((x) => x && x !== ".").join(" > ");
      for (const piece of pack(body)) {
        if (piece.length < CHUNK_MIN_CHARS) continue;
        chunks.push({ id: hash(s.repo + rel + title + piece), t: title, u: s.url(rel), x: piece, src: s.name, lic: s.licence });
      }
    }
  }
  return dedupe(chunks);
}

function dedupe(chunks: Chunk[]): Chunk[] {
  const seen = new Set<string>();
  return chunks.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

// ---------- module and plugin docs (ansible.builtin) ----------

type Doc = {
  short_description?: string;
  description?: string | string[];
  notes?: string | string[];
  options?: Record<string, Opt>;
  version_added?: string;
  deprecated?: { why?: string; alternative?: string; removed_in?: string };
};
type Opt = { description?: string | string[]; type?: string; default?: unknown; choices?: unknown[] | Record<string, unknown>; required?: boolean; aliases?: string[]; elements?: string; version_added?: string };

const join = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(" ") : v ?? "");
const clean = (s: string) => s.replace(/[ILBCMOVERU]\(([^)]*)\)/g, "`$1`").replace(/\s+/g, " ").trim();

/**
 * One chunk each for synopsis, parameters and examples, per the design.
 * Long parameter lists are split so each chunk stays within the size budget.
 */
export function chunkBuiltinPlugins(): Chunk[] {
  const dump = execFileSync("ansible-doc", ["--metadata-dump", "--no-fail-on-errors"], {
    maxBuffer: 1024 ** 3,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, ANSIBLE_DEPRECATION_WARNINGS: "False", ANSIBLE_NOCOLOR: "1" },
  });
  const all = JSON.parse(dump).all as Record<string, Record<string, { doc?: Doc; examples?: string; return?: Record<string, { description?: string | string[]; returned?: string; type?: string }> }>>;
  const chunks: Chunk[] = [];
  for (const [ptype, plugins] of Object.entries(all)) {
    for (const [fqcn, info] of Object.entries(plugins)) {
      if (!fqcn.startsWith("ansible.builtin.") || !info?.doc) continue;
      const doc = info.doc;
      const short = fqcn.split(".").slice(2).join(".");
      const u = `https://docs.ansible.com/ansible/latest/collections/ansible/builtin/${short}_${ptype}.html`;
      const base = `${fqcn} ${ptype}`;
      const add = (section: string, x: string) => {
        if (x.trim().length >= 60)
          chunks.push({ id: hash(fqcn + ptype + section + x), t: `${base} > ${section}`, u, x: x.trim(), src: "ansible-core plugin docs", lic: "GPL-3.0-or-later", fq: fqcn });
      };

      const dep = doc.deprecated ? `\n\nDEPRECATED: ${clean(doc.deprecated.why ?? "")} ${doc.deprecated.alternative ? `Use instead: ${clean(doc.deprecated.alternative)}.` : ""} ${doc.deprecated.removed_in ? `Removed in ${doc.deprecated.removed_in}.` : ""}` : "";
      add(
        "Synopsis",
        `${fqcn} (${ptype} plugin, ansible-core ${VERSION}): ${clean(doc.short_description ?? "")}\n\n${clean(join(doc.description))}${dep}${doc.notes ? `\n\nNotes: ${clean(join(doc.notes))}` : ""}`,
      );

      const opts = Object.entries(doc.options ?? {}).map(([k, o]) => {
        const meta = [
          o.type && `type: ${o.type}${o.elements ? ` of ${o.elements}` : ""}`,
          o.required && "required",
          o.default !== undefined && o.default !== null && `default: ${JSON.stringify(o.default)}`,
          o.choices && `choices: ${(Array.isArray(o.choices) ? o.choices : Object.keys(o.choices)).map((c) => JSON.stringify(c)).join(", ")}`,
          o.aliases?.length && `aliases: ${o.aliases.join(", ")}`,
          o.version_added && `added in ${o.version_added}`,
        ].filter(Boolean).join("; ");
        return `- \`${k}\` (${meta}): ${clean(join(o.description))}`;
      });
      for (const [i, piece] of pack(opts.join("\n\n")).entries()) add(`Parameters${i ? ` (part ${i + 1})` : ""}`, `Parameters of ${fqcn}:\n\n${piece}`);

      if (info.examples) for (const [i, piece] of pack("```yaml\n" + info.examples.trim() + "\n```").entries()) add(`Examples${i ? ` (part ${i + 1})` : ""}`, `Examples for ${fqcn}:\n\n${piece}`);

      const rets = Object.entries(info.return ?? {}).map(([k, r]) => `- \`${k}\` (${r.type ?? "any"}, returned ${r.returned ?? "?"}): ${clean(join(r.description))}`);
      if (rets.length) add("Return values", `Return values of ${fqcn}:\n\n${rets.join("\n")}`.slice(0, CHUNK_MAX_CHARS));
    }
  }
  return dedupe(chunks);
}
