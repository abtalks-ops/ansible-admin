// Builds the static PWA into pwa/dist: app bundle, service worker, index shards, embedder model and ONNX runtime.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "..");
const out = path.join(here, "dist");
const modelsDir = process.env.MODELS_DIR ?? path.join(root, "models");
const indexDir = path.join(root, "dist", "index");
const MODEL_ID = "Xenova/bge-small-en-v1.5";
const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"];
const ORT = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];

if (!fs.existsSync(path.join(indexDir, "manifest.json"))) throw new Error("No index found: run `npm run build:index` first.");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return fs.statSync(to).size;
};

for (const f of ["index.html", "styles.css", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"]) copy(path.join(here, f), path.join(out, f));
fs.cpSync(indexDir, path.join(out, "index"), { recursive: true });

const assets = { model: { id: MODEL_ID, files: [] }, runtime: [] };
for (const f of MODEL_FILES) {
  const src = path.join(modelsDir, MODEL_ID, f);
  if (!fs.existsSync(src)) {
    if (f === "special_tokens_map.json") continue; // optional
    throw new Error(`Missing model file ${src} (set MODELS_DIR)`);
  }
  assets.model.files.push({ path: f, bytes: copy(src, path.join(out, "models", MODEL_ID, f)) });
}
const ortDist = path.join(root, "node_modules", "onnxruntime-web", "dist");
assets.runtime.push({ path: "vendor/transformers.min.js", bytes: copy(path.join(root, "node_modules/@huggingface/transformers/dist/transformers.min.js"), path.join(out, "vendor/transformers.min.js")) });
for (const f of ORT) assets.runtime.push({ path: `ort/${f}`, bytes: copy(path.join(ortDist, f), path.join(out, "ort", f)) });
fs.writeFileSync(path.join(out, "assets.json"), JSON.stringify(assets, null, 2));

await build({
  entryPoints: [path.join(here, "src/app.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: process.env.MINIFY !== "0",
  sourcemap: false,
  outfile: path.join(out, "app.js"),
  // onnxruntime-web is loaded by transformers.js from the self-hosted ort/ files at runtime.
  logLevel: "warning",
});
// WebLLM is a separate bundle, loaded only when the user turns on AI answers (it is not part of the first download).
await build({
  entryPoints: [path.join(root, "node_modules/@mlc-ai/web-llm/lib/index.js")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: process.env.MINIFY !== "0",
  outfile: path.join(out, "vendor/web-llm.js"),
  logLevel: "warning",
});
// The GPU model runs in this worker (WebLLM), off the main thread.
await build({
  entryPoints: [path.join(here, "src/webllm-worker.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: process.env.MINIFY !== "0",
  outfile: path.join(out, "vendor/webllm-worker.js"),
  logLevel: "warning",
});
// CPU models: wllama (llama.cpp on WebAssembly). It starts its own worker; both wasm builds are self-hosted.
await build({
  entryPoints: [path.join(root, "node_modules/@wllama/wllama/esm/index.js")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: process.env.MINIFY !== "0",
  outfile: path.join(out, "vendor/wllama.js"),
  logLevel: "warning",
});
copy(path.join(root, "node_modules/@wllama/wllama/esm/wasm/wllama.wasm"), path.join(out, "vendor/wllama.wasm"));
copy(path.join(root, "node_modules/@wllama/wllama-compat/wasm/wllama.wasm"), path.join(out, "vendor/wllama-compat.wasm"));
const AI_VENDOR = ["web-llm.js", "webllm-worker.js", "wllama.js", "wllama.wasm", "wllama-compat.wasm"];
const vendorHash = createHash("sha256");
for (const f of AI_VENDOR) vendorHash.update(fs.readFileSync(path.join(out, "vendor", f)));
const shellHash = createHash("sha256")
  .update(["app.js", "index.html", "styles.css"].map((f) => fs.readFileSync(path.join(out, f))).join(""))
  .digest("hex")
  .slice(0, 12);
await build({
  entryPoints: [path.join(here, "src/sw.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  outfile: path.join(out, "sw.js"),
  define: { SHELL_VERSION: JSON.stringify(shellHash), VENDOR_VERSION: JSON.stringify(vendorHash.digest("hex").slice(0, 12)), AI_VENDOR: JSON.stringify(AI_VENDOR) },
  logLevel: "warning",
});

const size = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).reduce((s, f) => s + size(path.join(p, f)), 0) : fs.statSync(p).size;
const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
console.log(`pwa/dist: app ${mb(size(path.join(out, "app.js")))}, index ${mb(size(path.join(out, "index")))}, model ${mb(size(path.join(out, "models")))}, runtime ${mb(size(path.join(out, "ort")))}, total ${mb(size(out))}`);
