// On-device answer model. Optional: search works without it.
// Two backends: WebLLM on the GPU (WebGPU), and transformers.js on the CPU (WebAssembly, the same runtime that
// already runs the search embedder) for phones whose GPU can't run a model. WebLLM is bundled separately
// (vendor/web-llm.js) and only loaded when a GPU model is used.
import type { MLCEngineInterface } from "@mlc-ai/web-llm";

export interface Tier {
  id: "cpu-smollm135" | "cpu-smollm" | "cpu-qwen" | "smollm" | "lfm" | "llama" | "qwen" | "gemma";
  backend: "cpu" | "gpu";
  label: string;
  modelId: string; // GPU: an id from WebLLM's prebuilt list. CPU: a Hugging Face repo with ONNX weights
  dtype?: "q4" | "q8"; // CPU only: which ONNX weights to load
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
  { id: "cpu-smollm", backend: "cpu", label: "SmolLM2 360M · CPU (no GPU)", modelId: "HuggingFaceTB/SmolLM2-360M-Instruct", dtype: "q4", downloadMB: 300, note: "works without a GPU, slower, simpler answers" },
  { id: "cpu-smollm135", backend: "cpu", label: "SmolLM2 135M · CPU (no GPU)", modelId: "HuggingFaceTB/SmolLM2-135M-Instruct", dtype: "q4", downloadMB: 120, note: "smallest, for phones with little memory, basic answers" },
  { id: "cpu-qwen", backend: "cpu", label: "Qwen 2.5 0.5B · CPU (no GPU)", modelId: "onnx-community/Qwen2.5-0.5B-Instruct", dtype: "q4", downloadMB: 500, note: "better answers than SmolLM2, slower" },
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
    diagnostics = [`browser: ${navigator.userAgent}`, "backend: CPU (WebAssembly, 1 thread)", `device memory: ${(navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? "?"} GB`, `model: ${tier.modelId} (${tier.dtype})`].join("\n");
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
export const modelFor = (tier: Tier) => tier.backend === "cpu" ? tier.modelId : PARAMS.get("model") ?? (!hasF16 && tier.f32Id ? tier.f32Id : tier.modelId);

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
  const engine = await webllm.CreateMLCEngine(
    modelFor(tier),
    { initProgressCallback: (p) => onProgress(p.progress, p.text) },
    // A small window keeps GPU memory low; the prompt is built to fit (see shared/answer.ts).
    { context_window_size: 2048 },
  );
  return {
    interruptGenerate: () => engine.interruptGenerate(),
    unload: () => engine.unload(),
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

/** CPU engine: transformers.js text generation on WebAssembly. Files come from the Hugging Face hub once and are kept in Cache Storage. */
async function loadCpuEngine(tier: Tier, onProgress: (fraction: number, text: string) => void): Promise<Engine> {
  const tf = (await import(/* @vite-ignore */ abs("vendor/transformers.min.js"))) as typeof import("@huggingface/transformers");
  const { env } = tf;
  env.allowRemoteModels = true;
  env.allowLocalModels = false; // the embedder was loaded from local files already; this model comes from the hub
  env.useBrowserCache = true; // keeps the model in Cache Storage ("transformers-cache") for offline use
  const wasm = env.backends.onnx.wasm!;
  wasm.wasmPaths = { mjs: abs("ort/ort-wasm-simd-threaded.mjs"), wasm: abs("ort/ort-wasm-simd-threaded.wasm") };
  wasm.numThreads = 1;
  const loaded = new Map<string, [number, number]>();
  const gen = (await tf.pipeline("text-generation", tier.modelId, {
    dtype: tier.dtype ?? "q4",
    device: "wasm",
    progress_callback: (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status !== "progress" || !p.file || !p.total) return;
      loaded.set(p.file, [p.loaded ?? 0, p.total]);
      let done = 0;
      let total = 0;
      for (const [d, t] of loaded.values()) {
        done += d;
        total += t;
      }
      onProgress(total ? done / total : 0, `Downloading ${tier.label.split(" · ")[0]} (${(done / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB)`);
    },
  })) as unknown as {
    tokenizer: unknown;
    (messages: unknown, opts: Record<string, unknown>): Promise<unknown>;
    dispose(): Promise<void>;
  };
  onProgress(1, "Model ready");
  let stopper: InstanceType<typeof tf.InterruptableStoppingCriteria> | null = null;
  return {
    interruptGenerate: () => stopper?.interrupt(),
    unload: () => gen.dispose(),
    async generate(messages, onToken, maxTokens = 250) {
      const t0 = performance.now();
      let first = 0;
      let tokens = 0;
      let text = "";
      stopper = new tf.InterruptableStoppingCriteria();
      const streamer = new tf.TextStreamer(gen.tokenizer as ConstructorParameters<typeof tf.TextStreamer>[0], {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (piece: string) => {
          if (!piece) return;
          if (!first) first = performance.now() - t0;
          tokens++;
          text += piece;
          onToken(text);
        },
      });
      await gen(messages, { max_new_tokens: maxTokens, do_sample: false, repetition_penalty: 1.1, streamer, stopping_criteria: stopper });
      return { text, tokens, firstMs: first, totalMs: performance.now() - t0 };
    },
  };
}

/** True when the model files are already in this browser's cache, so enabling it needs no download. */
export async function isDownloaded(tier: Tier): Promise<boolean> {
  if (mock()) return false;
  try {
    if (tier.backend === "cpu") {
      const cache = await caches.open("transformers-cache");
      return (await cache.keys()).some((r) => r.url.includes(tier.modelId) && r.url.endsWith(".onnx"));
    }
    const webllm = (await import(/* @vite-ignore */ abs("vendor/web-llm.js"))) as typeof import("@mlc-ai/web-llm");
    return await webllm.hasModelInCache(modelFor(tier));
  } catch {
    return false;
  }
}
