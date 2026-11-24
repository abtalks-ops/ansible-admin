// On-device answer model (WebLLM, WebGPU). Optional: search works without it.
// The WebLLM library is bundled separately (vendor/web-llm.js) and only loaded when the user enables AI answers.
import type { MLCEngineInterface } from "@mlc-ai/web-llm";

export interface Tier {
  id: "small";
  label: string;
  modelId: string; // an id from WebLLM's prebuilt model list
  downloadMB: number; // approximate, shown before the download
}

export const SMALL: Tier = { id: "small", label: "Small", modelId: "Llama-3.2-1B-Instruct-q4f16_1-MLC", downloadMB: 700 };

// Read once: the app rewrites the query string as you search.
const PARAMS = new URLSearchParams(location.search);
const abs = (p: string) => new URL(p, location.href).href;

export type Engine = Pick<MLCEngineInterface, "interruptGenerate" | "unload"> & {
  generate(messages: Array<{ role: "system" | "user"; content: string }>, onToken: (text: string) => void): Promise<string>;
};

export interface DeviceCheck {
  ok: boolean;
  reason?: string;
  memoryGB?: number;
}

/** WebGPU is required. navigator.deviceMemory (Chrome only) is capped at 8 and rounded down. */
export async function checkDevice(): Promise<DeviceCheck> {
  if (mock()) return { ok: true };
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown | null> } }).gpu;
  if (!gpu) return { ok: false, reason: "This browser has no WebGPU. Search still works; AI answers need a recent Chrome or Safari." };
  const adapter = await gpu.requestAdapter().catch(() => null);
  if (!adapter) return { ok: false, reason: "No usable GPU was found for the browser. Search still works." };
  const memoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (memoryGB !== undefined && memoryGB < 3) return { ok: false, reason: `This device reports ${memoryGB} GB of memory, too little for the model.`, memoryGB };
  return { ok: true, memoryGB };
}

/** ?llm=mock swaps in a canned model so the app can be tested without a GPU or a download. */
export const mock = () => PARAMS.get("llm") === "mock";

/** ?model=<WebLLM model id> lets us try other models on a device without a new build. */
export const modelFor = (tier: Tier) => PARAMS.get("model") ?? tier.modelId;

function mockEngine(): Engine {
  let stop = false;
  return {
    interruptGenerate() { stop = true; },
    async unload() {},
    async generate(messages, onToken) {
      stop = false;
      const user = messages[messages.length - 1].content;
      const out = /Question:[^\n]*(not in the docs|zzzz)/i.test(user)
        ? "NOT_IN_DOCS"
        : "To do this, use the module described in the first passage [1]. The second passage covers a related option [2]. See also [9].\n\n```yaml\n- name: Example\n  ansible.builtin.debug:\n    msg: hello\n```";
      let text = "";
      for (const w of out.split(/(?<=\s)/)) {
        if (stop) break;
        text += w;
        onToken(text);
        await new Promise((r) => setTimeout(r, 15));
      }
      return text;
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
  const webllm = (await import(/* @vite-ignore */ abs("vendor/web-llm.js"))) as typeof import("@mlc-ai/web-llm");
  const engine = await webllm.CreateMLCEngine(modelFor(tier), { initProgressCallback: (p) => onProgress(p.progress, p.text) });
  return {
    interruptGenerate: () => engine.interruptGenerate(),
    unload: () => engine.unload(),
    async generate(messages, onToken) {
      const stream = await engine.chat.completions.create({ messages, stream: true, temperature: 0.1, top_p: 0.9, max_tokens: 700 });
      let text = "";
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta?.content ?? "";
        onToken(text);
      }
      return text;
    },
  };
}

/** True when the model files are already in this browser's cache, so enabling it needs no download. */
export async function isDownloaded(tier: Tier): Promise<boolean> {
  if (mock()) return false;
  try {
    const webllm = (await import(/* @vite-ignore */ abs("vendor/web-llm.js"))) as typeof import("@mlc-ai/web-llm");
    return await webllm.hasModelInCache(modelFor(tier));
  } catch {
    return false;
  }
}
