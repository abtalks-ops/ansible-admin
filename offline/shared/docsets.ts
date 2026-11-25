// Doc sets: the products an index holds (ansible-core, Red Hat AAP, ...). ansible-core is always
// installed; the others are optional, so a phone can skip what it doesn't need.
// Runs in Node and in the browser: no Node or DOM APIs here.
import type { Manifest } from "./search.ts";

export const REQUIRED_PRODUCT = "ansible-core";

const LABELS: Record<string, { label: string; credit: string }> = {
  "ansible-core": { label: "ansible-core", credit: "GPL-3.0, © Ansible project contributors" },
  aap: { label: "Red Hat Ansible Automation Platform", credit: "CC BY-SA 4.0, © Red Hat" },
};

export interface DocSet {
  product: string;
  version: string;
  label: string;
  credit: string;
  required: boolean;
  chunks: number;
  bytes: number;
}

/** One entry per product in the manifest, required first, with its passage count and download size. */
export function docSets(m: Manifest): DocSet[] {
  const by = new Map<string, DocSet>();
  for (const s of m.shards) {
    const known = LABELS[s.product];
    const d = by.get(s.product) ?? {
      product: s.product,
      version: s.version,
      label: known?.label ?? s.product,
      credit: known?.credit ?? "",
      required: s.product === REQUIRED_PRODUCT,
      chunks: 0,
      bytes: 0,
    };
    d.chunks += s.chunks;
    d.bytes += s.meta.bytes + s.vec.bytes;
    by.set(s.product, d);
  }
  return [...by.values()].sort((a, b) => Number(b.required) - Number(a.required));
}

/**
 * The manifest cut down to the required product plus the optional products in `enabled`,
 * with its stats recounted. `enriched` cannot be split per shard, so it is capped at the passage count.
 */
export function selectShards(m: Manifest, enabled: Iterable<string>): Manifest {
  const on = new Set(enabled);
  const shards = m.shards.filter((s) => s.product === REQUIRED_PRODUCT || on.has(s.product));
  const chunks = shards.reduce((n, s) => n + s.chunks, 0);
  return {
    ...m,
    shards,
    stats: {
      chunks,
      rows: shards.reduce((n, s) => n + s.rows, 0),
      bytes: shards.reduce((n, s) => n + s.meta.bytes + s.vec.bytes, 0),
      enriched: Math.min(m.stats.enriched, chunks),
    },
  };
}

/** Saved choice of optional products; null when the user hasn't chosen yet. Survives garbage. */
export function parseChoice(raw: string | null): string[] | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/** Before any choice: every optional set on a desktop, none on a phone (they cost download size). */
export function defaultChoice(m: Manifest, phone: boolean): string[] {
  return phone ? [] : docSets(m).filter((d) => !d.required).map((d) => d.product);
}

/** Products a manifest holds, e.g. to show what is installed. */
export const productsOf = (m: Manifest) => [...new Set(m.shards.map((s) => s.product))];
