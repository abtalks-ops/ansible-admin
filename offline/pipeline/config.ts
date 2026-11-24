import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const RAW_DIR = path.join(ROOT, "raw"); // git checkouts (ignored)
export const WORK_DIR = path.join(ROOT, "work"); // intermediate files (ignored)
export const OUT_DIR = path.join(ROOT, "dist", "index"); // what gets published
export const MODELS_DIR = process.env.MODELS_DIR ?? path.join(ROOT, "models");

/** The product version this build covers. Phase 1 is one ansible-core version. */
export const PRODUCT = "ansible-core";
export const VERSION = process.env.CORE_VERSION ?? "2.22";

export interface RepoSource {
  name: string;
  repo: string;
  ref: string;
  dir: string;
  licence: string; // still to be verified before launch, see the design doc
  url: (relPath: string) => string;
}

export const SOURCES: RepoSource[] = [
  {
    name: "ansible-core docs",
    repo: "ansible/ansible-documentation",
    ref: `stable-${VERSION}`,
    dir: "docs/docsite/rst",
    licence: "GPL-3.0-or-later",
    url: (rel) => `https://docs.ansible.com/ansible/latest/${rel.replace(/\.rst$/, ".html")}`,
  },
];

/** Doc folders that are noise for an admin assistant (roadmaps, community process). */
export const SKIP_DIRS = ["roadmap/", "community/", "shared_snippets/", "404.rst", "porting_guides/porting_guide_2", "porting_guides/porting_guide_3", "porting_guides/porting_guide_4", "porting_guides/porting_guide_5", "porting_guides/porting_guide_6", "porting_guides/porting_guide_7", "porting_guides/porting_guide_8"];

/** Chunk target. 300-500 tokens per the design; ~4 chars per token for English docs. */
export const CHUNK_MAX_CHARS = 1800;
export const CHUNK_MIN_CHARS = 120;

export const EMBEDDER = {
  id: "Xenova/bge-small-en-v1.5",
  dtype: "q8" as const, // the same quantized file the phone downloads
  dims: 384,
  pooling: "cls" as const,
  query_prefix: "Represent this sentence for searching relevant passages: ",
};

/** Max chunks per shard; keeps each download small enough to retry cheaply. */
export const SHARD_MAX_CHUNKS = 1500;

export const ENRICH_MODEL = process.env.ENRICH_MODEL ?? "claude-opus-5-5";
