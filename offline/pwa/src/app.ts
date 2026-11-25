// Ansible Admin Offline: download the index once, then search the docs with no network.
// Phase 1 is search only: hybrid BM25 + vector retrieval, answer cards when present, sources always shown.
import { SearchIndex, tokenize, unpack, type Chunk, type LoadedShard, type Manifest, type ShardMeta } from "../../shared/search.ts";
import { buildPrompt, citedNumbers, isDeviceLost, isNotInDocs, PROFILES, stripInvalidCitations, type Used } from "../../shared/answer.ts";
import { MAX_CONVS, newConv, parse as parseChats, remove as removeConv, serialize as serializeChats, titleFrom, upsert as upsertConv, type Conv, type Turn } from "../../shared/chats.ts";
import { addDiagnostic, checkDevice, getDiagnostics, isDownloaded, loadEngine, mock, modelFor, statsText, TIERS, DEFAULT_TIER, allowed, type Engine, type Tier } from "./llm.ts";
import { startRain } from "./rain.ts";

const DATA_CACHE = "aa-data-v1";
const INSTALLED = new URL("installed-manifest.json", location.href).href; // synthetic cache key
const abs = (p: string) => new URL(p, location.href).href;

interface Assets {
  model: { id: string; files: Array<{ path: string; bytes: number }> };
  runtime: Array<{ path: string; bytes: number }>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  setup: $("setup"), main: $("main"), panel: $("panel"), stats: $("stats"),
  sizeInfo: $("sizeInfo"), downloadBtn: $<HTMLButtonElement>("downloadBtn"), progress: $("progress"), bar: $("bar"), progressText: $("progressText"),
  form: $<HTMLFormElement>("searchForm"), q: $<HTMLInputElement>("q"), status: $("status"), results: $("thread"),
  newBtn: $("newBtn"), historyBtn: $("historyBtn"), drawer: $("drawer"), historyList: $("historyList"), newBtn2: $("newBtn2"), closeDrawer: $("closeDrawer"), backdrop: $("backdrop"), aiChip: $("aiChip"),
  aiInfo: $("aiInfo"), aiDiag: $("aiDiag"), aiBtn: $<HTMLButtonElement>("aiBtn"), aiModel: $<HTMLSelectElement>("aiModel"), aiProgress: $("aiProgress"), aiBar: $("aiBar"),
  menuBtn: $("menuBtn"), updateBtn: $<HTMLButtonElement>("updateBtn"), deleteBtn: $<HTMLButtonElement>("deleteBtn"), rainToggle: $<HTMLInputElement>("rainToggle"),
};

let index: SearchIndex | null = null;
let installed: Manifest | null = null;
let embedQuery: ((q: string) => Promise<Float32Array>) | null = null;
let embedderState: "idle" | "loading" | "ready" | "failed" = "idle";
let engine: Engine | null = null;
let engineModel = ""; // model id the loaded engine belongs to
let tier: Tier = DEFAULT_TIER;
let generating = false;
let convs: Conv[] = [];
let cur: Conv | null = null; // the open chat; null means a new, empty chat
let chunkById = new Map<string, Chunk>();
let embedderReady: Promise<void> = Promise.resolve();

// ---------- storage ----------

async function getInstalled(): Promise<Manifest | null> {
  const cache = await caches.open(DATA_CACHE);
  const res = await cache.match(INSTALLED);
  return res ? res.json() : null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function filesFor(m: Manifest, a: Assets): Array<{ url: string; bytes: number }> {
  return [
    ...m.shards.flatMap((s) => [s.meta, s.vec].map((f) => ({ url: abs(`index/${f.path}`), bytes: f.bytes }))),
    ...a.model.files.map((f) => ({ url: abs(`models/${a.model.id}/${f.path}`), bytes: f.bytes })),
    ...a.runtime.map((f) => ({ url: abs(f.path), bytes: f.bytes })),
  ];
}

/** Downloads every file the manifest needs that is not cached yet, then swaps the manifest in. */
async function install(onProgress: (done: number, total: number) => void): Promise<Manifest> {
  const [manifest, assets] = await Promise.all([fetchJson<Manifest>("index/manifest.json"), fetchJson<Assets>("assets.json")]);
  const cache = await caches.open(DATA_CACHE);
  const want = filesFor(manifest, assets);
  const missing: typeof want = [];
  for (const f of want) if (!(await cache.match(f.url))) missing.push(f);
  const total = missing.reduce((s, f) => s + f.bytes, 0);
  let done = 0;
  onProgress(0, total);
  // A few downloads at a time; each file lands in the cache only when complete.
  const queue = [...missing];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const res = await fetch(f.url, { cache: "no-store" });
        if (!res.ok || !res.body) throw new Error(`Download failed: ${f.url} (${res.status})`);
        const reader = res.body.getReader();
        const parts: Uint8Array[] = [];
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          parts.push(value);
          done += value.length;
          onProgress(Math.min(done, total), total);
        }
        await cache.put(f.url, new Response(new Blob(parts as BlobPart[]), { headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream" } }));
      }
    }),
  );
  // Atomic swap: the new manifest is written only after all of its files are cached.
  await cache.put(INSTALLED, new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } }));
  // Drop files no longer referenced (old shards).
  const keep = new Set([INSTALLED, abs("vendor/web-llm.js"), ...want.map((f) => f.url)]);
  for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
  return manifest;
}

async function loadIndex(m: Manifest): Promise<SearchIndex> {
  const cache = await caches.open(DATA_CACHE);
  const shards: LoadedShard[] = await Promise.all(
    m.shards.map(async (s) => {
      const metaRes = await cache.match(abs(`index/${s.meta.path}`));
      const vecRes = await cache.match(abs(`index/${s.vec.path}`));
      if (!metaRes || !vecRes) throw new Error(`Shard ${s.id} is missing from storage; run an update.`);
      const meta = (await metaRes.json()) as ShardMeta;
      return { meta, ...unpack(await vecRes.arrayBuffer(), meta.rows.length, meta.dims) };
    }),
  );
  return new SearchIndex(shards);
}

// ---------- embedder (same model and settings as the build) ----------

async function loadEmbedder(m: Manifest) {
  if (embedderState !== "idle") return;
  embedderState = "loading";
  renderStatus();
  try {
    // The prebuilt, self-contained transformers.js bundle is loaded as-is (re-bundling it breaks its tokenizer).
    const url = abs("vendor/transformers.min.js");
    const { pipeline, env } = (await import(/* @vite-ignore */ url)) as typeof import("@huggingface/transformers");
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    // A path, not a full URL: transformers.js skips its local file check for http(s) URLs.
    env.localModelPath = new URL("models/", location.href).pathname;
    env.useBrowserCache = false; // our own cache (served by the service worker) already holds the files
    env.useWasmCache = false;
    const wasm = env.backends.onnx.wasm!;
    wasm.wasmPaths = { mjs: abs("ort/ort-wasm-simd-threaded.mjs"), wasm: abs("ort/ort-wasm-simd-threaded.wasm") };
    wasm.numThreads = 1; // threads need cross-origin isolation, which static hosts rarely set
    const ext = await pipeline("feature-extraction", m.embedder.id, { dtype: m.embedder.dtype as "q8", device: "wasm" });
    embedQuery = async (q: string) => {
      const out = await ext(m.embedder.query_prefix + q, { pooling: m.embedder.pooling, normalize: true });
      return out.data as Float32Array;
    };
    embedderState = "ready";
  } catch (e) {
    console.error(e);
    embedderState = "failed";
  }
  renderStatus();
}

// ---------- rendering ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function highlight(html: string, terms: string[]): string {
  if (!terms.length) return html;
  const re = new RegExp(`\\b(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi");
  // Only touch text outside tags.
  return html.replace(/(^|>)([^<]+)/g, (_, a, text) => a + text.replace(re, "<mark>$1</mark>"));
}

/** Inline Markdown: code, bold, emphasis; source line wraps are joined except before list items. */
function inline(raw: string): string {
  return esc(raw)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s.,;:)]|$)/g, "$1<em>$2</em>")
    // Docs source wraps lines at ~80 chars: keep breaks only before list items.
    .replace(/\n(?=\s*(?:[-*+] |\d+\. ))/g, "<br>")
    .replace(/\n/g, " ");
}

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSeparator = (l: string) => isRow(l) && /^[\s|:-]+$/.test(l) && l.includes("-");
const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

function tableHtml(head: string, rows: string[], terms: string[]): string {
  const cell = (tag: string, c: string) => `<${tag}>${highlight(inline(c), terms)}</${tag}>`;
  return `<div class="tablewrap"><table><thead><tr>${cells(head).map((c) => cell("th", c)).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${cells(r).map((c) => cell("td", c)).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

/** Small Markdown subset: fenced code, inline code, bold, paragraphs, bullets, tables. */
function md(text: string, terms: string[] = []): string {
  const out: string[] = [];
  const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g);
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 1) continue;
    if (i % 3 === 2) {
      out.push(`<pre><button class="copy" type="button">copy</button><code>${esc(parts[i].replace(/\n$/, ""))}</code></pre>`);
      continue;
    }
    for (const para of parts[i].split(/\n\s*\n/)) {
      const p = para.trim();
      if (!p) continue;
      // A paragraph can hold a table (rows on consecutive lines starting with "|") next to ordinary text.
      let text: string[] = [];
      const flush = () => {
        if (!text.length) return;
        out.push(`<p>${highlight(inline(text.join("\n")), terms)}</p>`);
        text = [];
      };
      const lines = p.split("\n");
      for (let k = 0; k < lines.length; k++) {
        if (isRow(lines[k]) && k + 1 < lines.length && isSeparator(lines[k + 1])) {
          let end = k + 2;
          while (end < lines.length && isRow(lines[end])) end++;
          flush();
          out.push(tableHtml(lines[k], lines.slice(k + 2, end), terms));
          k = end - 1;
        } else text.push(lines[k]);
      }
      flush();
    }
  }
  return out.join("");
}

function resultHtml(c: Chunk, terms: string[], i: number): string {
  const crumb = c.t.split(" > ").slice(-3).join(" › ");
  return `<article class="result">
    <div class="crumb">${i + 1}. ${esc(crumb)}</div>
    <div class="meta"><a href="${esc(c.u)}" target="_blank" rel="noopener">${esc(c.u.replace(/^https:\/\/docs\.ansible\.com\/ansible\/latest\//, "docs/"))}</a><span>${esc(c.src)} · ${esc(c.lic)}</span></div>
    ${c.sum ? `<p class="sum">${highlight(esc(c.sum), terms)}</p>` : ""}
    <div class="body clamped">${md(c.x, terms)}</div>
    <button class="more" type="button">show more</button>
  </article>`;
}

const SHOWN = 3;
/** The top few results are open; the rest sit in a collapsed section so a phone screen isn't a wall of text. */
function resultsHtml(chunks: Chunk[], terms: string[]): string {
  const top = chunks.slice(0, SHOWN).map((c, i) => resultHtml(c, terms, i)).join("");
  const rest = chunks.slice(SHOWN);
  if (!rest.length) return top;
  return `${top}<details class="more-results"><summary>Show ${rest.length} more result${rest.length > 1 ? "s" : ""}</summary>${rest.map((c, i) => resultHtml(c, terms, SHOWN + i)).join("")}</details>`;
}

function renderStatus(extra = "") {
  const sem = { idle: "", loading: "semantic search loading…", ready: "semantic + keyword search", failed: "keyword search only (semantic model failed to load)" }[embedderState];
  ui.status.textContent = [extra, sem].filter(Boolean).join(" · ");
}

// ---------- chat: turns, history ----------

const EXAMPLES = ["run a handler immediately", "variable precedence extra vars", "retry a task until it succeeds", "ansible.builtin.copy backup", "encrypt a string with vault", "become a different user"];
const CHATS_KEY = "aa-chats";
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function loadChats() {
  try {
    convs = parseChats(localStorage.getItem(CHATS_KEY));
  } catch {
    convs = [];
  }
}
function saveChats() {
  // If storage is full, keep fewer chats rather than losing the current one.
  for (let keep = MAX_CONVS; keep >= 5; keep = Math.floor(keep / 2)) {
    try {
      localStorage.setItem(CHATS_KEY, serializeChats(convs.slice(0, keep)));
      return;
    } catch {}
  }
}

function renderEmpty() {
  ui.results.innerHTML = `<div class="empty-hint muted small">Ask about ansible-core. Everything runs on this device. Try:</div><div class="chips">${EXAMPLES.map((e) => `<button type="button">${esc(e)}</button>`).join("")}</div>`;
}

const cardHtml = (c: Chunk | undefined) => {
  const card = c?.card;
  return card
    ? `<section class="card"><h3>${esc(card.title)}</h3><div class="body">${md(card.answer_md)}</div><div class="meta"><a href="${esc(card.source_url)}" target="_blank" rel="noopener">source</a><span>answer card, written at build time</span></div></section>`
    : "";
};

/** Search results for a turn: open when there is no AI answer, collapsed under the answer when there is one. */
function resultsBlock(t: Turn, chunks: Chunk[]): string {
  const terms = [...new Set(tokenize(t.q))].filter((x) => x.length > 2);
  const body = cardHtml(chunks[0]) + (chunks.length ? resultsHtml(chunks, terms) : `<p class="muted">No matches. Try a module name, an option, or the error text.</p>`);
  return t.state === "search" ? body : `<details class="srcs"><summary>Search results (${chunks.length})</summary>${body}</details>`;
}

function answerHtml(t: Turn, used: Used[], busy: boolean, loadMsg = ""): string {
  if (t.state === "search" && !busy) return "";
  const text = t.answer ?? "";
  const cited = citedNumbers(text, used);
  const sources = cited.length
    ? `<ul class="sources">${cited.map((n) => { const c = used.find((u) => u.n === n)!.chunk; return `<li>[${n}] <a href="${esc(c.u)}" target="_blank" rel="noopener">${esc(c.t.split(" > ").slice(-2).join(" › "))}</a></li>`; }).join("")}</ul>`
    : "";
  const stop = busy && !loadMsg ? `<button type="button" class="ghost stopBtn">stop</button>` : "";
  const body = loadMsg
    ? `<p class="muted">${esc(loadMsg)}</p>`
    : t.state === "notindocs"
      ? `<p>The docs on this device don't seem to answer that. Check the search results below, or try different words.</p>`
      : t.state === "error"
        ? `<p class="muted">${esc(t.note ?? "The AI answer failed.")} The search results below still work.</p>`
        : withCitations(md(text), used);
  const model = esc(t.model ?? "");
  const foot = busy
    ? `<p class="muted small note">${loadMsg ? "" : `Generating on this device with ${model}…`}</p>`
    : t.state === "done" || t.state === "notindocs"
      ? `<p class="muted small note">✓ Written on this device by <b>${model}</b>${t.stats ? ` · ${esc(t.stats)}` : ""}. It can make mistakes: check the sources.</p>`
      : "";
  return `<section class="card answer${busy ? " busy" : ""}"><h3><span>✦ Answer</span><span class="tools">${stop}</span></h3><div class="body">${body}</div>${sources}${foot}</section>`;
}

function turnEl(t: Turn): HTMLElement {
  const chunks = t.hits.map((id) => chunkById.get(id)).filter((c): c is Chunk => !!c);
  const el = document.createElement("section");
  el.className = "turn";
  el.innerHTML = `<div class="q">${esc(t.q)}</div><div class="ai"></div><div class="res">${resultsBlock(t, chunks)}</div>`;
  el.querySelector(".ai")!.innerHTML = answerHtml(t, buildPrompt(t.q, chunks).used, false);
  return el;
}

function renderThread() {
  ui.results.innerHTML = "";
  if (!cur || !cur.turns.length) return renderEmpty();
  for (const t of cur.turns) ui.results.append(turnEl(t));
}

function renderHistory() {
  ui.historyList.innerHTML = convs.length
    ? convs
        .map((c) => `<li class="${c.id === cur?.id ? "current" : ""}"><button type="button" class="hist" data-id="${esc(c.id)}">${esc(c.title)}<small>${esc(new Date(c.ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))} · ${c.turns.length} question${c.turns.length === 1 ? "" : "s"}</small></button><button type="button" class="del" data-id="${esc(c.id)}" aria-label="Delete chat">✕</button></li>`)
        .join("")
    : `<li class="muted small">No chats yet.</li>`;
}

const setDrawer = (open: boolean) => {
  ui.drawer.hidden = !open;
  ui.backdrop.hidden = !open;
  if (open) renderHistory();
};

function newChat() {
  if (generating) engine?.interruptGenerate();
  cur = null;
  setDrawer(false);
  ui.panel.hidden = true;
  renderThread();
  renderStatus();
  ui.q.value = "";
  ui.q.focus();
}

function openChat(id: string) {
  const c = convs.find((x) => x.id === id);
  if (!c) return;
  if (generating) engine?.interruptGenerate();
  cur = c;
  setDrawer(false);
  renderThread();
  renderStatus(`${c.turns.length} question${c.turns.length === 1 ? "" : "s"} in this chat`);
  ui.results.lastElementChild?.scrollIntoView({ block: "start" });
}

async function ask(q: string) {
  if (!index || generating) return;
  const query = q.trim();
  if (!query) return;
  ui.q.value = "";
  const t0 = performance.now();
  await Promise.race([embedderReady, new Promise((r) => setTimeout(r, 5000))]); // semantic search joins when it is ready
  const qv = embedQuery ? await embedQuery(query) : null;
  const hits = index.hybrid(query, qv, 8).map((h) => h.chunk);
  const ms = Math.round(performance.now() - t0);
  if (!cur) cur = newConv(uid(), Date.now());
  if (!cur.turns.length) {
    cur.title = titleFrom(query);
    ui.results.innerHTML = "";
  }
  const turn: Turn = { q: query, hits: hits.map((c) => c.id), state: "search" };
  cur.turns.push(turn);
  cur.ts = Date.now();
  convs = upsertConv(convs, cur);
  saveChats();
  const el = turnEl(turn);
  ui.results.append(el);
  el.scrollIntoView({ block: "start", behavior: "smooth" });
  renderStatus(`${hits.length} results in ${ms} ms`);
  if (aiOn() && hits.length) await generateFor(turn, el, hits);
}

function renderStats(m: Manifest) {
  const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
  ui.stats.innerHTML = [
    ["Product", [...new Set(m.shards.map((s) => `${s.product} ${s.version}`))].join(", ")],
    ["Passages", m.stats.chunks.toLocaleString()],
    ["Index size", mb(m.stats.bytes)],
    ["Built", new Date(m.built_at).toLocaleString()],
    ["Embedder", `${m.embedder.id} (${m.embedder.dtype})`],
    ["Semantic search", embedderState],
  ]
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join("");
}

// ---------- on-device AI answers (optional) ----------

const aiOn = () => {
  try {
    return localStorage.getItem("aa-ai") === "1";
  } catch {
    return false;
  }
};
const setAi = (on: boolean) => {
  try {
    localStorage.setItem("aa-ai", on ? "1" : "0");
  } catch {}
};

try {
  tier = TIERS.find((t) => t.id === localStorage.getItem("aa-ai-model") && allowed(t)) ?? DEFAULT_TIER;
} catch {}
ui.aiModel.innerHTML = TIERS.map((t) => `<option value="${t.id}"${allowed(t) ? "" : " disabled"}>${esc(t.label)} · about ${t.downloadMB} MB · ${allowed(t) ? esc(t.note) : "computers only, too heavy for phones"}</option>`).join("");
ui.aiModel.value = tier.id;

function renderAiPanel(msg = "") {
  const on = aiOn();
  ui.aiModel.value = tier.id;
  ui.aiBtn.textContent = on ? "Turn off AI answers" : `Turn on AI answers (about ${tier.downloadMB} MB)`;
  ui.aiInfo.textContent =
    msg ||
    (on
      ? `On. ${tier.label}, runs on this device after a one-time download. Answers are written from the search results and can be wrong: check the sources.`
      : "A small language model on this device can write a short answer from the top search results. Needs a recent browser with WebGPU. Search works without it.");
}

/** Keeps the WebLLM library in the data cache so it also loads with no network. */
async function cacheWebLlm() {
  const url = abs("vendor/web-llm.js");
  const cache = await caches.open(DATA_CACHE);
  if (!(await cache.match(url))) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Couldn't download the AI runtime (${res.status})`);
    await cache.put(url, res);
  }
}

async function ensureEngine(onProgress: (f: number, t: string) => void): Promise<Engine> {
  if (engine && engineModel === modelFor(tier)) return engine;
  if (engine) {
    await engine.unload().catch(() => {});
    engine = null;
  }
  await cacheWebLlm().catch((e) => {
    if (!mock()) throw e;
  });
  await navigator.storage?.persist?.();
  engine = await loadEngine(tier, onProgress);
  engineModel = modelFor(tier);
  return engine;
}

async function toggleAi() {
  if (aiOn()) {
    setAi(false);
    try {
      localStorage.removeItem(FLAKY); // turning AI off and on again gives the normal prompt size another go
    } catch {}
    await engine?.unload().catch(() => {});
    engine = null;
    setChip("off");
    return renderAiPanel();
  }
  const dev = await checkDevice(tier);
  renderDiag();
  if (!dev.ok) return renderAiPanel(dev.reason);
  if (!(await isDownloaded(tier)) && !confirm(`Download ${tier.label} (about ${tier.downloadMB} MB)? Wi-Fi recommended. It stays on this device.`)) return;
  ui.aiBtn.disabled = true;
  ui.aiProgress.hidden = false;
  try {
    setChip("loading");
    await ensureEngine((f, t) => {
      setChip("loading", `${Math.round(f * 100)}%`);
      ui.aiBar.style.width = `${Math.round(f * 100)}%`;
      ui.aiInfo.textContent = t;
    });
    setAi(true);
    renderAiPanel();
    setChip("ready");
  } catch (e) {
    engine = null;
    renderAiPanel(`Couldn't load the model: ${(e as Error).message}. Search still works.`);
  } finally {
    ui.aiBtn.disabled = false;
    ui.aiProgress.hidden = true;
  }
}

function withCitations(html: string, used: Used[]): string {
  return html
    .split(/(<pre>[\s\S]*?<\/pre>)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/\[(\d{1,2})\]/g, (m, d) => {
            const u = used.find((x) => x.n === Number(d));
            return u ? `<a class="cite" href="${esc(u.chunk.u)}" target="_blank" rel="noopener" title="${esc(u.chunk.t)}">${m}</a>` : m;
          }),
    )
    .join("");
}

/** The header chip says which model is in use and what it is doing, so it is clear the AI is really running. */
function setChip(state: "off" | "on" | "loading" | "ready" | "busy" | "failed", detail = "") {
  const name = tier.label.replace(/ \(.*\)$/, "");
  const label = {
    off: "AI off",
    on: `AI: ${name} on`,
    loading: `AI: loading ${name}${detail ? ` ${detail}` : ""}`,
    ready: `AI: ${name} ready`,
    busy: `AI: ${name} answering…`,
    failed: "AI: unavailable",
  }[state];
  ui.aiChip.textContent = (mock() ? "[mock] " : "") + label;
  ui.aiChip.dataset.state = state;
}

// If the browser dies while the model is loading or answering, the page reloads with this flag still set.
const GUARD = "aa-gen";
const guard = (on: boolean) => {
  try {
    if (on) localStorage.setItem(GUARD, String(Date.now()));
    else localStorage.removeItem(GUARD);
  } catch {}
};
addEventListener("pagehide", () => guard(false));
function checkCrash(): boolean {
  try {
    if (localStorage.getItem(GUARD)) {
      guard(false);
      setAi(false);
      return true;
    }
  } catch {}
  return false;
}

const renderDiag = () => (ui.aiDiag.textContent = getDiagnostics() || "(turn on AI answers to collect GPU details)");

// After a GPU reset the phone gets shorter prompts and answers from then on.
const FLAKY = "aa-gpu-flaky";
const isFlaky = () => {
  try {
    return localStorage.getItem(FLAKY) === "1";
  } catch {
    return false;
  }
};
const setFlaky = () => {
  try {
    localStorage.setItem(FLAKY, "1");
  } catch {}
};

async function generateFor(turn: Turn, el: HTMLElement, chunks: Chunk[]) {
  generating = true;
  ui.q.disabled = true;
  const aiEl = el.querySelector(".ai") as HTMLElement;
  turn.model = modelFor(tier);
  turn.state = "done";
  guard(true);
  let used: Used[] = buildPrompt(turn.q, chunks).used;
  try {
    // Attempt 2 exists for GPU resets: the engine is rebuilt and the prompt is shortened.
    for (let attempt = 0; attempt < 2; attempt++) {
      const budget = attempt > 0 || isFlaky() || tier.backend === "cpu" ? PROFILES.lite : PROFILES.normal;
      const prompt = buildPrompt(turn.q, chunks, budget);
      used = prompt.used;
      try {
        if (!engine || engineModel !== modelFor(tier)) {
          setChip("loading");
          aiEl.innerHTML = answerHtml(turn, used, true, "Loading the AI model into memory…");
          await ensureEngine((f, t) => {
            setChip("loading", `${Math.round(f * 100)}%`);
            aiEl.innerHTML = answerHtml(turn, used, true, `${t} (${Math.round(f * 100)}%)`);
          });
        }
        setChip("busy");
        aiEl.innerHTML = answerHtml(turn, used, true);
        const r = await engine!.generate(
          prompt.messages,
          (t) => {
            turn.answer = stripInvalidCitations(t, used);
            // Hold back a reply that is still spelling out NOT_IN_DOCS.
            if ("NOT_IN_DOCS".startsWith(t.trim().toUpperCase().replace(/[^A-Z_]/g, "")) && t.trim()) return;
            aiEl.innerHTML = answerHtml(turn, used, true);
          },
          budget.maxTokens,
        );
        turn.stats = statsText(r) + (tier.backend === "cpu" ? " · CPU" : " · GPU") + (budget === PROFILES.lite && tier.backend !== "cpu" ? " · short mode" : "");
        if (isNotInDocs(r.text)) {
          turn.state = "notindocs";
          turn.answer = undefined;
        } else turn.answer = stripInvalidCitations(r.text, used);
        turn.note = undefined;
        setChip("ready");
        return;
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        addDiagnostic(`error (${new Date().toLocaleTimeString()}): ${msg}`);
        await engine?.unload().catch(() => {});
        engine = null;
        turn.answer = undefined;
        if (isDeviceLost(msg) && attempt === 0) {
          // The GPU was reset or ran out of memory. Remember it, rebuild the engine and try once more with less.
          setFlaky();
          aiEl.innerHTML = answerHtml(turn, used, true, "The phone's GPU was reset. Reloading the model and trying again with a shorter prompt…");
          continue;
        }
        turn.state = "error";
        turn.note = isDeviceLost(msg)
          ? "The phone's GPU was reset again (likely out of memory). Close other tabs and apps and try again, switch to a CPU model in settings (they don't use the GPU), or turn AI answers off. Details are under AI answers in settings."
          : `The AI answer failed: ${msg}.`;
        setChip("failed");
        return;
      }
    }
  } finally {
    guard(false);
    generating = false;
    ui.q.disabled = false;
    renderDiag();
    aiEl.innerHTML = answerHtml(turn, used, false);
    el.querySelector(".res")!.innerHTML = resultsBlock(turn, chunks);
    saveChats();
  }
}

// ---------- flow ----------

async function showMain(m: Manifest) {
  installed = m;
  ui.setup.hidden = true;
  ui.main.hidden = false;
  ui.status.textContent = "loading index…";
  index = await loadIndex(m);
  chunkById = new Map(index.chunks.map((c) => [c.id, c]));
  loadChats();
  const crashed = checkCrash();
  renderStats(m);
  renderAiPanel(crashed ? "The browser stopped unexpectedly while the AI model was running, so AI answers were turned off. Search still works. Try a different model, or leave AI off." : "");
  setChip(aiOn() ? "on" : "off");
  const q = new URLSearchParams(location.search).get("q");
  cur = null;
  renderThread();
  renderStatus(crashed ? "AI answers were turned off after the browser stopped unexpectedly" : `${m.stats.chunks.toLocaleString()} passages ready offline`);
  if (crashed) ui.panel.hidden = false;
  embedderReady = loadEmbedder(m).then(() => renderStats(m));
  if (q) await ask(q);
}

async function showSetup() {
  ui.setup.hidden = false;
  ui.main.hidden = true;
  try {
    const [m, a] = await Promise.all([fetchJson<Manifest>("index/manifest.json"), fetchJson<Assets>("assets.json")]);
    const total = filesFor(m, a).reduce((s, f) => s + f.bytes, 0);
    ui.sizeInfo.textContent = `${(total / 1e6).toFixed(0)} MB download: ${m.stats.chunks.toLocaleString()} passages of ${m.shards[0]?.product} ${m.shards[0]?.version} docs, plus the search model. Wi-Fi recommended.`;
  } catch {
    ui.sizeInfo.textContent = "You're offline and nothing is downloaded yet. Connect once to download the docs.";
    ui.downloadBtn.disabled = true;
  }
}

async function runInstall(btn: HTMLButtonElement) {
  btn.disabled = true;
  ui.progress.hidden = false;
  try {
    await navigator.storage?.persist?.(); // ask the browser not to evict the index
    const m = await install((done, total) => {
      ui.bar.style.width = `${total ? (100 * done) / total : 100}%`;
      ui.progressText.textContent = total ? `${(done / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB` : "Already up to date";
    });
    ui.progress.hidden = true;
    ui.progressText.textContent = "";
    embedderState = "idle";
    embedQuery = null;
    await showMain(m);
  } catch (e) {
    ui.progressText.textContent = `${(e as Error).message}. Your previous index, if any, is untouched.`;
  } finally {
    btn.disabled = false;
  }
}

ui.downloadBtn.addEventListener("click", () => runInstall(ui.downloadBtn));
ui.newBtn.addEventListener("click", newChat);
ui.newBtn2.addEventListener("click", newChat);
ui.historyBtn.addEventListener("click", () => setDrawer(ui.drawer.hidden));
ui.closeDrawer.addEventListener("click", () => setDrawer(false));
ui.backdrop.addEventListener("click", () => setDrawer(false));
ui.aiChip.addEventListener("click", () => {
  ui.panel.hidden = false;
  ui.menuBtn.setAttribute("aria-expanded", "true");
  ui.panel.scrollIntoView({ block: "start" });
});
ui.historyList.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest("button");
  const id = t?.dataset.id;
  if (!t || !id) return;
  if (t.classList.contains("del")) {
    if (!confirm("Delete this chat?")) return;
    convs = removeConv(convs, id);
    saveChats();
    if (cur?.id === id) {
      cur = null;
      renderThread();
    }
    renderHistory();
  } else openChat(id);
});
ui.aiBtn.addEventListener("click", () => void toggleAi());
ui.aiModel.addEventListener("change", async () => {
  tier = TIERS.find((t) => t.id === ui.aiModel.value && allowed(t)) ?? DEFAULT_TIER;
  try {
    localStorage.setItem("aa-ai-model", tier.id);
  } catch {}
  if (!aiOn()) return renderAiPanel();
  // AI is on: switch now, downloading the new model if it isn't on this device yet.
  setAi(false);
  await engine?.unload().catch(() => {});
  engine = null;
  renderAiPanel();
  await toggleAi();
});
ui.form.addEventListener("submit", (e) => {
  e.preventDefault();
  void ask(ui.q.value);
});
ui.results.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains("stopBtn")) engine?.interruptGenerate();
  else if (t.matches(".chips button")) {
    void ask(t.textContent ?? "");
  } else if (t.matches(".more")) {
    const body = t.previousElementSibling as HTMLElement;
    body.classList.toggle("clamped");
    t.textContent = body.classList.contains("clamped") ? "show more" : "show less";
  } else if (t.matches("pre .copy")) {
    void navigator.clipboard?.writeText(t.nextElementSibling?.textContent ?? "");
    t.textContent = "copied";
    setTimeout(() => (t.textContent = "copy"), 1200);
  }
});
ui.menuBtn.addEventListener("click", () => {
  ui.panel.hidden = !ui.panel.hidden;
  ui.menuBtn.setAttribute("aria-expanded", String(!ui.panel.hidden));
});
ui.updateBtn.addEventListener("click", async () => {
  if (!navigator.onLine) return void (ui.status.textContent = "You're offline; connect to check for updates.");
  const remote = await fetchJson<Manifest>("index/manifest.json").catch(() => null);
  if (!remote) return void (ui.status.textContent = "Couldn't reach the update server.");
  if (remote.built_at === installed?.built_at) return void (ui.status.textContent = "Index is up to date.");
  if (remote.index_format !== installed?.index_format) ui.status.textContent = "New index format: downloading a full index.";
  ui.main.hidden = true;
  ui.setup.hidden = false;
  await runInstall(ui.updateBtn);
});
ui.deleteBtn.addEventListener("click", async () => {
  if (!confirm("Delete the downloaded docs, AI model and chat history from this device?")) return;
  await caches.delete(DATA_CACHE);
  for (const k of await caches.keys()) if (k.startsWith("webllm/") || k === "transformers-cache") await caches.delete(k); // downloaded AI models
  setAi(false);
  engine = null;
  try {
    localStorage.removeItem(CHATS_KEY);
  } catch {}
  convs = [];
  cur = null;
  index = null;
  installed = null;
  ui.panel.hidden = true;
  await showSetup();
});

let stopRain: (() => void) | null = null;
const setRain = (on: boolean) => {
  stopRain?.();
  stopRain = on ? startRain($("rain") as unknown as HTMLCanvasElement) : null;
  try {
    localStorage.setItem("aa-rain", on ? "1" : "0");
  } catch {}
};
ui.rainToggle.addEventListener("change", () => setRain(ui.rainToggle.checked));

(async () => {
  let rainPref = true;
  try {
    rainPref = localStorage.getItem("aa-rain") !== "0";
  } catch {}
  ui.rainToggle.checked = rainPref;
  setRain(rainPref);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW registration failed", e));
  const m = await getInstalled().catch(() => null);
  if (m) await showMain(m).catch(async (e) => {
    console.error(e);
    await showSetup();
  });
  else await showSetup();
})();
