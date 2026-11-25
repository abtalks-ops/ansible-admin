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
  /** "rst" (default): RST/Markdown pages. "asciidoc": Red Hat books under titles/ (ansible/aap-docs). */
  kind?: "rst" | "asciidoc";
  /** Product and version the shard is labelled with; defaults to PRODUCT and VERSION. */
  product?: string;
  version?: string;
}

/** Red Hat Ansible Automation Platform docs version (ansible/aap-docs branch). */
export const AAP_VERSION = process.env.AAP_VERSION ?? "2.6";
/**
 * The aap-docs commit the committed chunks and enrichment were made from. Chunk ids hash the
 * text, so building from a newer commit can orphan enrichment; move the pin on purpose, then run
 * `npm run check:enrichment`. AAP_REF overrides it (a branch name or commit).
 */
const AAP_PIN: Record<string, string> = { "2.6": "0eb284c4d9011314f865be991ae63a6a1b4faeb3" };
export const AAP_REF = process.env.AAP_REF ?? AAP_PIN[AAP_VERSION] ?? AAP_VERSION;

export const SOURCES: RepoSource[] = [
  {
    name: "ansible-core docs",
    repo: "ansible/ansible-documentation",
    ref: `stable-${VERSION}`,
    dir: "docs/docsite/rst",
    licence: "GPL-3.0-or-later",
    url: (rel) => `https://docs.ansible.com/ansible/latest/${rel.replace(/\.rst$/, ".html")}`,
  },
  {
    // Red Hat's own source for docs.redhat.com. CC BY-SA 4.0 (LICENSE.txt in the repo):
    // passages and the enrichment written from them are shared under the same licence, credited to Red Hat.
    name: "Red Hat AAP docs",
    repo: "ansible/aap-docs",
    ref: AAP_REF,
    dir: "downstream",
    licence: "CC-BY-SA-4.0",
    url: () => `https://docs.redhat.com/en/documentation/red_hat_ansible_automation_platform/${AAP_VERSION}`,
    kind: "asciidoc",
    product: "aap",
    version: AAP_VERSION,
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
