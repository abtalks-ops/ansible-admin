// AsciiDoc books (Red Hat AAP docs, ansible/aap-docs) -> chunks.
// Each title under downstream/titles/.../master.adoc is one published guide. Its includes are
// expanded with the attributes and ifdef/ifndef conditions in force, the result is turned
// into Markdown-ish text, split on headings and packed like the RST docs.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Chunk } from "../shared/search.ts";
import { CHUNK_MAX_CHARS, CHUNK_MIN_CHARS, type RepoSource } from "./config.ts";
import { pack } from "./chunk.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export interface Book {
  dir: string; // title folder, relative to the titles root
  title: string;
  slug: string; // docs.redhat.com URL segment
}

type Attrs = Map<string, string>;

/** Replaces {name} references; unknown ones are left as they are. */
const BUILTIN: Record<string, string> = { nbsp: " ", plus: "+", empty: "", sp: " ", amp: "&", lt: "<", gt: ">", startsb: "[", endsb: "]", vbar: "|", caret: "^", asterisk: "*", tilde: "~", backslash: "\\", backtick: "`", "two-colons": "::", "zwsp": "" };

export function subst(s: string, attrs: Attrs): string {
  s = s.replace(/\{([\w-]+)\}/g, (m, k) => (attrs.has(k) ? m : BUILTIN[k] ?? m));
  for (let i = 0; i < 3 && /\{[\w-]+\}/.test(s); i++) s = s.replace(/\{([\w-]+)\}/g, (m, k) => attrs.get(k) ?? m);
  return s;
}

function condition(names: string, attrs: Attrs): boolean {
  if (names.includes("+")) return names.split("+").every((n) => attrs.has(n.trim()));
  return names.split(",").some((n) => attrs.has(n.trim()));
}

/** Simple ifeval support: "{a}" == "b", {a} >= 2 and similar; anything else counts as true. */
function evaluate(expr: string, attrs: Attrs): boolean {
  const m = /^\s*(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/.exec(subst(expr, attrs));
  if (!m) return true;
  const un = (v: string) => v.replace(/^["']|["']$/g, "");
  const [a, b] = [un(m[1]), un(m[3])];
  const [na, nb] = [Number(a), Number(b)];
  const num = !Number.isNaN(na) && !Number.isNaN(nb);
  switch (m[2]) {
    case "==": return a === b;
    case "!=": return a !== b;
    case ">=": return num ? na >= nb : a >= b;
    case "<=": return num ? na <= nb : a <= b;
    case ">": return num ? na > nb : a > b;
    default: return num ? na < nb : a < b;
  }
}

/** Sets or unsets an attribute from an entry line (":name: value", ":name!:", ":!name:"). Returns false if it isn't one. */
function attrEntry(line: string, attrs: Attrs): boolean {
  const m = /^:(!?)([\w-]+)(!?):(?:\s+(.*))?$/.exec(line);
  if (!m) return false;
  if (m[1] || m[3]) attrs.delete(m[2]);
  else attrs.set(m[2], subst((m[4] ?? "").trim(), attrs));
  return true;
}

/**
 * Expands one file: includes, attributes, conditionals and comments. Headings get the
 * include's leveloffset applied. Returns plain AsciiDoc lines.
 */
export function expand(file: string, attrs: Attrs, offset = 0, depth = 0, out: string[] = []): string[] {
  if (depth > 20 || !fs.existsSync(file)) return out;
  const lines = fs.readFileSync(file, "utf8").replace(/\r/g, "").split("\n");
  const stack: boolean[] = []; // one entry per open ifdef; true = active
  const active = () => stack.every(Boolean);
  let comment = false;
  let fence: string | null = null; // inside ---- or .... nothing is a directive except include
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!fence && line.trim() === "////") {
      comment = !comment;
      continue;
    }
    if (comment) continue;
    if (!fence && line.startsWith("//")) continue;

    const cond = /^(ifdef|ifndef|ifeval)::([^\[]*)\[(.*)\]\s*$/.exec(line);
    if (cond) {
      const [, kind, names, content] = cond;
      const ok = kind === "ifeval" ? evaluate(content, attrs) : kind === "ifdef" ? condition(names, attrs) : !condition(names, attrs);
      if (kind !== "ifeval" && content) {
        // Single-line form: ifdef::x[content]
        if (active() && ok && !attrEntry(content, attrs)) out.push(subst(content, attrs));
      } else stack.push(ok);
      continue;
    }
    if (/^endif::.*\[\]\s*$/.test(line)) {
      stack.pop();
      continue;
    }
    if (!active()) continue;

    const inc = /^include::([^\[]+)\[(.*)\]\s*$/.exec(line);
    if (inc) {
      const target = subst(inc[1], attrs);
      if (/\{[\w-]+\}/.test(target) || /\.(png|svg|jpe?g)$/i.test(target)) continue;
      const lo = /lev\w*offset=([+-]?)(\d+)/.exec(inc[2]);
      const next = lo ? (lo[1] === "+" ? offset + Number(lo[2]) : lo[1] === "-" ? offset - Number(lo[2]) : Number(lo[2])) : offset;
      const resolved = path.resolve(path.dirname(file), target);
      if (/\.(yml|yaml|json|j2|sh|txt|cfg|ini|py|xml)$/i.test(target)) {
        // Included sample files sit inside a source block already.
        if (fs.existsSync(resolved)) out.push(...fs.readFileSync(resolved, "utf8").replace(/\r/g, "").trimEnd().split("\n"));
      } else expand(resolved, attrs, next, depth + 1, out);
      continue;
    }

    if (fence) {
      if (line.trim() === fence) fence = null;
      out.push(line);
      continue;
    }
    if (/^(----|\.\.\.\.)\s*$/.test(line)) {
      fence = line.trim();
      out.push(line);
      continue;
    }
    if (attrEntry(line, attrs)) continue;
    const h = /^(=+)\s+(.+)$/.exec(line);
    if (h) {
      out.push(`${"=".repeat(Math.max(1, h[1].length + offset))} ${h[2]}`);
      continue;
    }
    out.push(line);
  }
  return out;
}

/** Inline markup -> Markdown-ish text. */
export function inline(s: string, attrs: Attrs): string {
  return subst(s, attrs)
    .replace(/pass:\w*\[([^\]]*)\]/g, "$1")
    .replace(/`\+([^`]*?)\+`/g, "`$1`")
    .replace(/\b(?:link|https?):(\/\/)?([^\s\[]*)\[([^\]]*)\]/g, (m, sl, url, text) => {
      const full = m.startsWith("link:") ? url : `${m.slice(0, m.indexOf(":"))}:${sl ?? ""}${url}`;
      const t = text.replace(/\^$/, "").replace(/,\s*window=.*$/, "").trim();
      // Links between Red Hat guides keep only their text: the URLs are long and add nothing to search.
      if (t && /docs\.redhat\.com|^\/?red_hat_ansible/.test(full)) return t;
      return t ? `${t} (${full})` : full;
    })
    .replace(/xref:[^\[\s]*\[([^\]]*)\]/g, "$1")
    .replace(/<<[^,>]+,\s*([^>]+)>>/g, "$1")
    .replace(/<<([^>]+)>>/g, (_, id) => id.replace(/[_-]/g, " "))
    .replace(/(menu|btn|kbd):\[?([^\[\]]*)\[([^\]]*)\]/g, (_, k, a, b) => (k === "menu" ? [a, ...b.split(",")].map((x: string) => x.trim()).filter(Boolean).join(" > ") : b || a))
    .replace(/image:[^\[]*\[[^\]]*\]/g, "")
    .replace(/footnote:\[([^\]]*)\]/g, " ($1)")
    .replace(/\[(role|\.)[^\]]*\]#([^#]*)#/g, "$2")
    .replace(/(^|\s)\+\s*$/, "$1")
    .replace(/&#8217;/g, "'")
    .replace(/\s+$/, "");
}

interface Section {
  trail: string[];
  anchor?: string;
  body: string;
}

/** Turns expanded AsciiDoc into sections with Markdown-ish bodies. */
export function toSections(lines: string[], attrs: Attrs): Section[] {
  const out: Section[] = [];
  const trail: string[] = [];
  const anchors: Array<string | undefined> = [];
  let anchor: string | undefined;
  let pendingAnchor: string | undefined;
  let buf: string[] = [];
  let fence: string | null = null;
  let pendingLang = "";
  let admon: string | null = null;
  const flush = () => {
    const body = buf.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (body) out.push({ trail: trail.filter(Boolean), anchor, body });
    buf = [];
  };
  for (const raw of lines) {
    if (fence) {
      if (raw.trim() === fence) {
        buf.push("```");
        fence = null;
      } else buf.push(subst(raw, attrs).replace(/\s+<\d+>\s*$/, ""));
      continue;
    }
    const line = raw.trimEnd();
    if (/^(----|\.\.\.\.)$/.test(line)) {
      fence = line;
      buf.push("```" + pendingLang);
      pendingLang = "";
      continue;
    }
    const idm = /^\[(?:id=["']?([^"'\],]+)["']?|#([^\],.]+))[^\]]*\]$/.exec(line);
    if (idm) {
      pendingAnchor = subst(idm[1] ?? idm[2], attrs);
      continue;
    }
    const src = /^\[(source|listing)(?:,\s*([\w+-]+))?[^\]]*\]$/.exec(line);
    if (src) {
      pendingLang = src[2] ?? "";
      continue;
    }
    const adm = /^\[(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/.exec(line);
    if (adm) {
      admon = adm[1];
      continue;
    }
    if (/^\[[^\]]*\]$/.test(line) || /^(====|\*\*\*\*|____|--)$/.test(line) || /^image::/.test(line) || line === "+" || /^toc::\[\]/.test(line)) {
      if (admon && line === "====") {
        buf.push(`${admon}:`);
        admon = null;
      }
      continue;
    }
    const h = /^(=+)\s+(.+)$/.exec(line);
    if (h) {
      flush();
      const lvl = h[1].length - 1;
      trail.length = lvl;
      trail[lvl] = inline(h[2], attrs).replace(/`/g, "");
      anchors.length = lvl;
      anchors[lvl] = pendingAnchor ?? anchors.slice(0, lvl).filter(Boolean).at(-1);
      anchor = anchors[lvl];
      pendingAnchor = undefined;
      admon = null;
      continue;
    }
    if (line.trim()) pendingAnchor = undefined;
    if (/^\|===/.test(line)) {
      buf.push("");
      continue;
    }
    let l = inline(line, attrs);
    if (/^\.[A-Za-z{`*_]/.test(line)) l = `**${l.slice(1)}**`; // block title
    else if (/^(\d*\*?[a-z]?)\|/.test(line)) l = l.split(/(?<!\\)\|/).slice(1).map((c) => c.replace(/\s+(\d*\*?[adehlmsv])$/, "").trim()).join(" | ");
    else if (/^(\.+)\s/.test(line)) l = l.replace(/^\.+\s/, "1. ");
    if (admon && l.trim()) {
      l = `${admon}: ${l}`;
      admon = null;
    }
    buf.push(l);
  }
  flush();
  return out;
}

/** Book list: every downstream/titles/.../master.adoc with its published title. */
export function findBooks(titlesDir: string): Book[] {
  const books: Book[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
      else if (e.name === "master.adoc") {
        const info = path.join(d, "docinfo.xml");
        const title = fs.existsSync(info) ? /<title>([^<]+)<\/title>/.exec(fs.readFileSync(info, "utf8"))?.[1]?.trim() : undefined;
        if (!title) continue;
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        books.push({ dir: path.relative(titlesDir, d), title, slug });
      }
    }
  };
  walk(titlesDir);
  return books.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Titles that are not product documentation for an admin (release-note history is kept). */
const SKIP_BOOKS = new Set<string>([]);

export function chunkAsciidocBooks(s: RepoSource, dir: string, docsVersion: string): Chunk[] {
  const titlesDir = path.join(dir, "titles");
  const chunks: Chunk[] = [];
  const seenText = new Set<string>();
  for (const book of findBooks(titlesDir)) {
    if (SKIP_BOOKS.has(book.dir)) continue;
    const attrs: Attrs = new Map([["Boilerplate", "__skip__"]]);
    const lines = expand(path.join(titlesDir, book.dir, "master.adoc"), attrs);
    for (const sec of toSections(lines, attrs)) {
      // trail[0] is the book title; legal notices and feedback boilerplate are not useful.
      if (/^(Legal Notice|Providing feedback on Red Hat documentation|Open Source license)$/i.test(sec.trail.at(-1) ?? "")) continue;
      const title = [book.title, ...sec.trail.slice(1)].join(" > ");
      const base = `https://docs.redhat.com/en/documentation/red_hat_ansible_automation_platform/${docsVersion}/html-single/${book.slug}/index`;
      const u = sec.anchor ? `${base}#${sec.anchor}` : base;
      for (const piece of pack(sec.body)) {
        if (piece.length < CHUNK_MIN_CHARS || piece.length > CHUNK_MAX_CHARS * 1.6) continue;
        // Modules shared by several guides: index the text once, under the first guide that has it.
        const textKey = hash(piece);
        if (seenText.has(textKey)) continue;
        seenText.add(textKey);
        chunks.push({ id: hash(s.repo + docsVersion + book.dir + title + piece), t: title, u, x: piece, src: s.name, lic: s.licence });
      }
    }
  }
  return chunks;
}
