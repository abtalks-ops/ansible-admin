// Ansible Admin Offline: download the index once, then search the docs with no network.
// Phase 1 is search only: hybrid BM25 + vector retrieval, answer cards when present, sources always shown.
import { SearchIndex, tokenize, unpack, type Chunk, type LoadedShard, type Manifest, type ShardMeta } from "../../shared/search.ts";
import { buildPrompt, citedNumbers, isNotInDocs, stripInvalidCitations, type Used } from "../../shared/answer.ts";
import { checkDevice, isDownloaded, loadEngine, mock, modelFor, TIERS, DEFAULT_TIER, type Engine, type Tier } from "./llm.ts";
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
  form: $<HTMLFormElement>("searchForm"), q: $<HTMLInputElement>("q"), status: $("status"), results: $("results"),
  answerBar: $("answerBar"), answerBtn: $<HTMLButtonElement>("answerBtn"), answer: $("answer"),
  aiInfo: $("aiInfo"), aiBtn: $<HTMLButtonElement>("aiBtn"), aiModel: $<HTMLSelectElement>("aiModel"), aiProgress: $("aiProgress"), aiBar: $("aiBar"),
  menuBtn: $("menuBtn"), updateBtn: $<HTMLButtonElement>("updateBtn"), deleteBtn: $<HTMLButtonElement>("deleteBtn"), rainToggle: $<HTMLInputElement>("rainToggle"),
};

let index: SearchIndex | null = null;
let installed: Manifest | null = null;
let embedQuery: ((q: string) => Promise<Float32Array>) | null = null;
let embedderState: "idle" | "loading" | "ready" | "failed" = "idle";
let engine: Engine | null = null;
let engineModel = ""; // model id the loaded engine belongs to
let tier: Tier = DEFAULT_TIER;
let lastQuery = "";
let lastHits: Chunk[] = [];
let generating = false;

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

const EXAMPLES = ["run a handler immediately", "variable precedence extra vars", "retry a task until it succeeds", "ansible.builtin.copy backup", "encrypt a string with vault", "become a different user"];

function renderEmpty() {
  ui.results.innerHTML = `<div class="empty-hint muted small">Everything below runs on this device. Try:</div><div class="chips">${EXAMPLES.map((e) => `<button type="button">${esc(e)}</button>`).join("")}</div>`;
}

async function search(q: string) {
  if (!index) return;
  const query = q.trim();
  if (!query) return renderEmpty();
  const t0 = performance.now();
  const qv = embedQuery ? await embedQuery(query) : null;
  const hits = index.hybrid(query, qv, 8);
  const ms = Math.round(performance.now() - t0);
  const terms = [...new Set(tokenize(query))].filter((t) => t.length > 2);
  lastQuery = query;
  lastHits = hits.map((h) => h.chunk);
  ui.answer.hidden = true;
  ui.answerBar.hidden = !(aiOn() && hits.length);
  const card = hits[0]?.chunk.card;
  ui.results.innerHTML =
    (card
      ? `<section class="card"><h3>${esc(card.title)}</h3><div class="body">${md(card.answer_md)}</div><div class="meta"><a href="${esc(card.source_url)}" target="_blank" rel="noopener">source</a><span>answer card, written at build time</span></div></section>`
      : "") + (hits.length ? resultsHtml(hits.map((h) => h.chunk), terms) : `<p class="muted">No matches. Try a module name, an option, or the error text.</p>`);
  renderStatus(`${hits.length} results in ${ms} ms`);
  history.replaceState(null, "", `?q=${encodeURIComponent(query)}`);
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
  tier = TIERS.find((t) => t.id === localStorage.getItem("aa-ai-model")) ?? DEFAULT_TIER;
} catch {}
ui.aiModel.innerHTML = TIERS.map((t) => `<option value="${t.id}">${esc(t.label)} · about ${t.downloadMB} MB · ${esc(t.note)}</option>`).join("");
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
    await engine?.unload().catch(() => {});
    engine = null;
    ui.answerBar.hidden = true;
    ui.answer.hidden = true;
    return renderAiPanel();
  }
  const dev = await checkDevice();
  if (!dev.ok) return renderAiPanel(dev.reason);
  if (!(await isDownloaded(tier)) && !confirm(`Download ${tier.label} (about ${tier.downloadMB} MB)? Wi-Fi recommended. It stays on this device.`)) return;
  ui.aiBtn.disabled = true;
  ui.aiProgress.hidden = false;
  try {
    await ensureEngine((f, t) => {
      ui.aiBar.style.width = `${Math.round(f * 100)}%`;
      ui.aiInfo.textContent = t;
    });
    setAi(true);
    renderAiPanel();
    ui.answerBar.hidden = !lastHits.length;
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

function showAnswer(text: string, used: Used[], state: "busy" | "done" | "notindocs" | "error", note = "") {
  ui.answer.hidden = false;
  ui.answer.classList.toggle("busy", state === "busy");
  const cited = citedNumbers(text, used);
  const sources = cited.length
    ? `<ul class="sources">${cited.map((n) => { const c = used.find((u) => u.n === n)!.chunk; return `<li>[${n}] <a href="${esc(c.u)}" target="_blank" rel="noopener">${esc(c.t.split(" > ").slice(-2).join(" › "))}</a></li>`; }).join("")}</ul>`
    : "";
  const stop = state === "busy" ? `<button type="button" class="ghost" id="stopBtn">stop</button>` : "";
  const body =
    state === "notindocs"
      ? `<p>The docs on this device don't seem to answer that. Check the search results below, or try different words.</p>`
      : state === "error"
        ? `<p class="muted">${esc(note)}</p>`
        : withCitations(md(text), used);
  ui.answer.innerHTML = `<h3><span>✦ Answer</span><span class="tools">${stop}</span></h3><div class="body">${body}</div>${sources}${state === "done" ? `<p class="muted small note">Written on this device by ${esc(modelFor(tier))} from the results below. It can make mistakes: check the sources.</p>` : ""}`;
}

async function writeAnswer() {
  if (generating || !lastHits.length) return;
  generating = true;
  ui.answerBtn.disabled = true;
  const { messages, used } = buildPrompt(lastQuery, lastHits);
  try {
    if (!engine) {
      ui.answer.hidden = false;
      ui.answer.innerHTML = `<h3><span>✦ Answer</span></h3><div class="body"><p class="muted" id="loadMsg">Loading the AI model…</p></div>`;
      await ensureEngine((f, t) => {
        const el = document.getElementById("loadMsg");
        if (el) el.textContent = `${t} (${Math.round(f * 100)}%)`;
      });
    }
    showAnswer("", used, "busy");
    const text = await engine!.generate(messages, (t) => {
      if (!"NOT_IN_DOCS".startsWith(t.trim().toUpperCase().replace(/[^A-Z_]/g, "")) || !t.trim()) showAnswer(stripInvalidCitations(t, used), used, "busy");
    });
    if (isNotInDocs(text)) showAnswer(text, used, "notindocs");
    else showAnswer(stripInvalidCitations(text, used), used, "done");
  } catch (e) {
    engine = null;
    showAnswer("", used, "error", `The AI answer failed: ${(e as Error).message}. The search results below still work.`);
  } finally {
    generating = false;
    ui.answerBtn.disabled = false;
  }
}

// ---------- flow ----------

async function showMain(m: Manifest) {
  installed = m;
  ui.setup.hidden = true;
  ui.main.hidden = false;
  ui.status.textContent = "loading index…";
  index = await loadIndex(m);
  renderStats(m);
  renderAiPanel();
  const q = new URLSearchParams(location.search).get("q");
  if (q) {
    ui.q.value = q;
    await search(q);
  } else renderEmpty();
  renderStatus(`${m.stats.chunks.toLocaleString()} passages ready offline`);
  void loadEmbedder(m).then(() => {
    renderStats(m);
    if (ui.q.value.trim()) void search(ui.q.value);
  });
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
ui.answerBtn.addEventListener("click", () => void writeAnswer());
ui.aiBtn.addEventListener("click", () => void toggleAi());
ui.aiModel.addEventListener("change", async () => {
  tier = TIERS.find((t) => t.id === ui.aiModel.value) ?? DEFAULT_TIER;
  try {
    localStorage.setItem("aa-ai-model", tier.id);
  } catch {}
  ui.answer.hidden = true;
  if (!aiOn()) return renderAiPanel();
  // AI is on: switch now, downloading the new model if it isn't on this device yet.
  setAi(false);
  await engine?.unload().catch(() => {});
  engine = null;
  renderAiPanel();
  await toggleAi();
});
ui.answer.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id === "stopBtn") engine?.interruptGenerate();
});
ui.form.addEventListener("submit", (e) => {
  e.preventDefault();
  void search(ui.q.value);
});
ui.results.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.matches(".chips button")) {
    ui.q.value = t.textContent ?? "";
    void search(ui.q.value);
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
  if (!confirm("Delete the downloaded docs and model from this device?")) return;
  await caches.delete(DATA_CACHE);
  for (const k of await caches.keys()) if (k.startsWith("webllm/")) await caches.delete(k); // downloaded AI model
  setAi(false);
  engine = null;
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
