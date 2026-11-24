// Step 6: embed with the same small open model the phone uses for questions.
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import fs from "node:fs";
import path from "node:path";
import { EMBEDDER, MODELS_DIR } from "./config.ts";

let extractor: FeatureExtractionPipeline | null = null;

async function load(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  // Use local model files when present (MODELS_DIR/<id>/...), else download from the Hugging Face hub.
  if (fs.existsSync(path.join(MODELS_DIR, EMBEDDER.id, "config.json"))) {
    env.localModelPath = MODELS_DIR + path.sep;
    env.allowRemoteModels = false;
  } else {
    // Download from the hub into MODELS_DIR, where the PWA build picks the files up.
    env.cacheDir = MODELS_DIR;
  }
  extractor = (await pipeline("feature-extraction", EMBEDDER.id, { dtype: EMBEDDER.dtype })) as FeatureExtractionPipeline;
  return extractor;
}

export async function embed(texts: string[], opts: { query?: boolean; batch?: number; onProgress?: (done: number) => void } = {}): Promise<Float32Array[]> {
  const ext = await load();
  const out: Float32Array[] = [];
  const size = opts.batch ?? 32;
  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size).map((t) => (opts.query ? EMBEDDER.query_prefix + t : t));
    const res = await ext(batch, { pooling: EMBEDDER.pooling, normalize: true });
    const data = res.data as Float32Array;
    for (let j = 0; j < batch.length; j++) out.push(data.slice(j * EMBEDDER.dims, (j + 1) * EMBEDDER.dims));
    opts.onProgress?.(Math.min(i + size, texts.length));
  }
  return out;
}

/** The text embedded for a chunk: heading trail plus passage (the model truncates at 512 tokens). */
export const passageText = (t: string, x: string) => `${t}\n\n${x}`;
