// On-device answer model. Optional: search works without it.
// Two backends, each in its own Web Worker so the page never freezes while a model works:
// - CPU: llama.cpp on WebAssembly (wllama, vendor/wllama.js) with GGUF models. The phone default, no GPU needed.
// - GPU: WebLLM on WebGPU (vendor/web-llm.js + vendor/webllm-worker.js), for computers.
// Both bundles load only when AI answers are turned on.
import type { MLCEngineInterface } from "@mlc-ai/web-llm";

export interface Tier {
  id: "cpu-smollm" | "smollm" | "lfm" | "llama" | "qwen" | "gemma";
  backend: "cpu" | "gpu";
  label: string;
  modelId: string; // GPU: an id from WebLLM's prebuilt list. CPU: a Hugging Face repo with GGUF files
  revision?: string; // CPU only: pinned commit of that repo
  file?: string; // CPU only: the GGUF file
  downloadMB: number; // approximate, shown before the download
  note: string;
  f32Id?: string; // build for GPUs without 16-bit shader support
  desktopOnly?: boolean; // too heavy for phone GPUs: disabled in the picker on phones
}

/**
 * The small models users can choose between, smallest GPU memory first (WebLLM's own estimate in brackets).
 * The two tiny ones are for phones whose GPU resets with the 1B models.
 */
export const TIERS: Tier[] = [
  // The same file and revision the offline-motivator app runs on phones.
  { id: "cpu-smollm", backend: "cpu", label: "SmolLM2 360M · CPU (no GPU)", modelId: "HuggingFaceTB/SmolLM2-360M-Instruct-GGUF", revision: "593b5a2e04c8f3e4ee880263f93e0bd2901ad47f", file: "smollm2-360m-instruct-q8_0.gguf", downloadMB: 390, note: "recommended for phones: no GPU needed, simpler answers" },
  { id: "smollm", backend: "gpu", label: "SmolLM2 360M · GPU", modelId: "SmolLM2-360M-Instruct-q4f16_1-MLC", f32Id: "SmolLM2-360M-Instruct-q4f32_1-MLC", downloadMB: 250, note: "tiny, about 0.4 GB of GPU memory, simpler answers" },
  { id: "lfm", backend: "gpu", label: "LFM2.5 350M · GPU (Liquid AI)", modelId: "LFM2.5-350M-q4f16_1-MLC", f32Id: "LFM2.5-350M-q4f32_1-MLC", downloadMB: 300, note: "tiny and built for phones, about 0.5 GB of GPU memory" },
  { id: "gemma", backend: "gpu", desktopOnly: true, label: "Gemma 3 1B · GPU (Google)", modelId: "gemma3-1b-it-q4f16_1-MLC", downloadMB: 700, note: "about 0.7 GB of GPU memory" },
  { id: "llama", backend: "gpu", desktopOnly: true, label: "Llama 3.2 1B · GPU (Meta)", modelId: "Llama-3.2-1B-Instruct-q4f16_1-MLC", f32Id: "Llama-3.2-1B-Instruct-q4f32_1-MLC", downloadMB: 700, note: "about 0.9 GB of GPU memory, better answers" },
  { id: "qwen", backend: "gpu", desktopOnly: true, label: "Qwen 2.5 1.5B · GPU (Alibaba)", modelId: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", f32Id: "Qwen2.5-1.5B-Instruct-q4f32_1-MLC", downloadMB: 950, note: "about 1.6 GB of GPU memory, best with code and YAML" },
];
/** Phones and tablets: their GPUs reset with the 1B models, so only the tiny ones are offered there. */
export const isPhone = () => {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  return nav.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
};
export const allowed = (t: Tier) => !(t.desktopOnly && isPhone());
export const DEFAULT_TIER = TIERS.find((t) => t.id === (isPhone() ? "cpu-smollm" : "llama"))!;

// Read once: the app rewrites the query string as you search.
const PARAMS = new URLSearchParams(location.search);
const abs = (p: string) => new URL(p, location.href).href;

export type Engine = Pick<MLCEngineInterface, "interruptGenerate" | "unload"> & {
  generate(messages: Array<{ role: "system" | "user"; content: string }>, onToken: (text: string) => void, maxTokens?: number): Promise<GenResult>;
};

export interface GenResult {
  text: string;
  tokens: number; // streamed pieces, close to the token count
  firstMs: number; // time to the first word
  totalMs: number;
}

/** "first word 1.2 s · 14 tokens/s · 210 tokens" */
export function statsText(r: GenResult): string {
  const rate = r.totalMs > r.firstMs ? ((r.tokens - 1) / ((r.totalMs - r.firstMs) / 1000)).toFixed(1) : "–";
  return `first word ${(r.firstMs / 1000).toFixed(1)} s · ${rate} tokens/s · ${r.tokens} tokens`;
}

export interface DeviceCheck {
  ok: boolean;
  reason?: string;
  memoryGB?: number;
}

let hasF16 = true;
let diagnostics = "";
export const getDiagnostics = () => diagnostics;
export const addDiagnostic = (line: string) => (diagnostics += (diagnostics ? "\n" : "") + line);

/** WebGPU is required. navigator.deviceMemory (Chrome only) is capped at 8 and rounded down. */
export async function checkDevice(tier: Tier = DEFAULT_TIER): Promise<DeviceCheck> {
  if (mock()) return { ok: true };
  if (tier.backend === "cpu") {
    diagnostics = [`browser: ${navigator.userAgent}`, "backend: CPU (llama.cpp WebAssembly in a worker, no GPU)", `JSPI: ${"Suspending" in WebAssembly ? "yes" : "no (compat build)"}  device memory: ${(navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? "?"} GB`, `model: ${tier.modelId}/${tier.file}`].join("\n");
    return { ok: true };
  }
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> } }).gpu;
  if (!gpu) return { ok: false, reason: "This browser has no WebGPU. Search still works; AI answers need a recent Chrome or Safari." };
  const adapter = await gpu.requestAdapter().catch(() => null);
  if (!adapter) return { ok: false, reason: "No usable GPU was found for the browser. Search still works." };
  const memoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  hasF16 = !!adapter.features?.has("shader-f16");
  const info = adapter.info;
  const mb = (n?: number) => (n ? `${Math.round(n / 1048576)} MB` : "?");
  diagnostics = [
    `browser: ${navigator.userAgent}`,
    `gpu: ${[info?.vendor, info?.architecture, info?.description].filter(Boolean).join(" / ") || "unknown"}`,
    `shader-f16: ${hasF16 ? "yes" : "no"}  device memory: ${memoryGB ?? "?"} GB`,
    `max buffer: ${mb(adapter.limits?.maxBufferSize)}  max storage binding: ${mb(adapter.limits?.maxStorageBufferBindingSize)}`,
    `model: ${modelFor(tier)}`,
  ].join("\n");
  if (memoryGB !== undefined && memoryGB < 3) return { ok: false, reason: `This device reports ${memoryGB} GB of memory, too little for the model.`, memoryGB };
  if (!hasF16 && !tier.f32Id && !PARAMS.get("model")) return { ok: false, reason: `This phone's GPU can't run the ${tier.label} build. Try Llama or Qwen.`, memoryGB };
  return { ok: true, memoryGB };
}

interface GpuAdapterLike {
  features?: { has(name: string): boolean };
  limits?: { maxBufferSize?: number; maxStorageBufferBindingSize?: number };
  info?: { vendor?: string; architecture?: string; description?: string };
}

/** ?llm=mock swaps in a canned model so the app can be tested without a GPU or a download. */
export const mock = () => PARAMS.get("llm")?.startsWith("mock") ?? false;
// ?llm=mock-gpufail: the first answer fails like a GPU reset, to test recovery.
let mockFailsLeft = PARAMS.get("llm") === "mock-gpufail" ? 1 : 0;

/** ?model=<WebLLM model id> lets us try other models on a device without a new build. */
export const modelFor = (tier: Tier) => tier.backend === "cpu" ? tier.file! : PARAMS.get("model") ?? (!hasF16 && tier.f32Id ? tier.f32Id : tier.modelId);

function mockEngine(): Engine {
  let stop = false;
  return {
    interruptGenerate() { stop = true; },
    async unload() {},
    async generate(messages, onToken, _maxTokens) {
      stop = false;
      if (mockFailsLeft-- > 0) throw new Error("Failed to execute 'mapAsync' on 'GPUBuffer': A valid external Instance reference no longer exists.");
      const t0 = performance.now();
      let first = 0;
      let tokens = 0;
      const user = messages[messages.length - 1].content;
      const out = /Question:[^\n]*(not in the docs|zzzz)/i.test(user)
        ? "NOT_IN_DOCS"
        : "To do this, use the module described in the first passage [1]. The second passage covers a related option [2]. See also [9].\n\n```yaml\n- name: Example\n  ansible.builtin.debug:\n    msg: hello\n```";
      let text = "";
      for (const w of out.split(/(?<=\s)/)) {
        if (stop) break;
        text += w;
        tokens++;
        if (!first) first = performance.now() - t0;
        onToken(text);
        await new Promise((r) => setTimeout(r, 15));
      }
      return { text, tokens, firstMs: first, totalMs: performance.now() - t0 };
    },
  };
}

/** Loads the model (downloading it on first use; WebLLM keeps it in the browser's Cache Storage). */
export async function loadEngine(tier: Tier, onProgress: (fraction: number, text: string) => void): Promise<Engine> {
  if (mock()) {
    for (let i = 1; i <= 5; i++) {
      onProgress(i / 5, `mock model ${i * 20}%`);
      await new Promise((r) => setTimeout(r, 40));
    }
    return mockEngine();
  }
  if (tier.backend === "cpu") return loadCpuEngine(tier, onProgress);
  const webllm = (await import(/* @vite-ignore */ abs("vendor/web-llm.js"))) as typeof import("@mlc-ai/web-llm");
  // The model runs in a worker so streaming tokens never block taps and scrolling.
  const worker = new Worker(abs("vendor/webllm-worker.js"), { type: "module" });
  const engine = await webllm.CreateWebWorkerMLCEngine(
    worker,
    modelFor(tier),
    { initProgressCallback: (p) => onProgress(p.progress, p.text) },
    // A small window keeps GPU memory low; the prompt is built to fit (see shared/answer.ts).
    { context_window_size: 2048 },
  );
  return {
    interruptGenerate: () => engine.interruptGenerate(),
    unload: async () => {
      await engine.unload().catch(() => {});
      worker.terminate(); // a worker whose GPU device was lost can't be reused
    },
    async generate(messages, onToken, maxTokens = 350) {
      const t0 = performance.now();
      let first = 0;
      let tokens = 0;
      const stream = await engine.chat.completions.create({ messages, stream: true, temperature: 0.1, top_p: 0.9, max_tokens: maxTokens });
      let text = "";
      for await (const chunk of stream) {
        const piece = chunk.choices[0]?.delta?.content ?? "";
        if (!piece) continue;
        if (!first) first = performance.now() - t0;
        tokens++;
        text += piece;
        onToken(text);
      }
      return { text, tokens, firstMs: first, totalMs: performance.now() - t0 };
    },
  };
}

/** Where a CPU model's GGUF file lives, pinned to a revision so the bytes never change under us. */
export const ggufUrl = (t: Tier) => `https://huggingface.co/${t.modelId}/resolve/${t.revision}/${t.file}`;

/**
 * CPU engine: llama.cpp compiled to WebAssembly (wllama), the setup that runs SmolLM2 360M on phones in the
 * offline-motivator app. It runs in its own Web Worker, so the page stays responsive while it thinks, and
 * n_gpu_layers 0 keeps it off the GPU completely (wllama 4 would otherwise use WebGPU when it can).
 * The model file is kept in the browser's private file system (OPFS) for offline use.
 */
async function loadCpuEngine(tier: Tier, onProgress: (fraction: number, text: string) => void): Promise<Engine> {
  const { Wllama } = (await import(/* @vite-ignore */ abs("vendor/wllama.js"))) as typeof import("@wllama/wllama");
  const w = new Wllama({ default: abs("vendor/wllama.wasm") }, { suppressNativeLog: true, allowOffline: true });
  // Browsers without JSPI or relaxed SIMD need the compat build; it is self-hosted so nothing comes from a CDN.
  w.setCompat({ wasm: abs("vendor/wllama-compat.wasm") });
  const name = tier.label.split(" · ")[0];
  try {
    await w.loadModelFromUrl(ggufUrl(tier), {
      n_ctx: 2048,
      n_gpu_layers: 0,
      progressCallback: ({ loaded, total }: { loaded: number; total: number }) =>
        onProgress(total ? loaded / total : 0, `Downloading ${name} (${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB)`),
    });
  } catch (e) {
    await w.exit().catch(() => {});
    throw e;
  }
  onProgress(1, "Model ready");
  addDiagnostic(`wllama: loaded ${tier.file}, ${crossOriginIsolated ? "multi-thread" : "1 thread"}`);
  let ctrl: AbortController | null = null;
  return {
    interruptGenerate: () => ctrl?.abort(),
    unload: () => w.exit(),
    async generate(messages, onToken, maxTokens = 250) {
      const t0 = performance.now();
      let first = 0;
      let tokens = 0;
      let text = "";
      ctrl = new AbortController();
      const signal = ctrl.signal;
      try {
        const stream = await w.createChatCompletion({ messages, stream: true, max_tokens: maxTokens, temperature: 0.1, abortSignal: signal });
        for await (const chunk of stream) {
          const piece = chunk.choices[0]?.delta?.content ?? "";
          if (!piece) continue;
          if (!first) first = performance.now() - t0;
          tokens++;
          text += piece;
          onToken(text);
        }
      } catch (e) {
        if (!signal.aborted) throw e; // a stop keeps the partial answer, like the GPU engine
      }
      return { text, tokens, firstMs: first, totalMs: performance.now() - t0 };
    },
  };
}

/** Removes downloaded CPU models (wllama keeps them in OPFS, not Cache Storage). */
export async function clearCpuModels(): Promise<void> {
  try {
    const { CacheManager } = (await import(/* @vite-ignore */ abs("vendor/wllama.js"))) as typeof import("@wllama/wllama");
    await new CacheManager().clear();
  } catch {}
}

/** True when the model files are already in this browser's cache, so enabling it needs no download. */
export async function isDownloaded(tier: Tier): Promise<boolean> {
  if (mock()) return false;
  try {
    if (tier.backend === "cpu") {
      const { CacheManager } = (await import(/* @vite-ignore */ abs("vendor/wllama.js"))) as typeof import("@wllama/wllama");
      const cm = new CacheManager();
      return (await cm.getSize(await cm.getNameFromURL(ggufUrl(tier)))) > 0;
    }
    const webllm = (await import(/* @vite-ignore */ abs("vendor/web-llm.js"))) as typeof import("@mlc-ai/web-llm");
    return await webllm.hasModelInCache(modelFor(tier));
  } catch {
    return false;
  }
}
