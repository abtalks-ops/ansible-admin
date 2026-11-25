import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultChoice, docSets, parseChoice, productsOf, selectShards } from "../shared/docsets.ts";
import type { Manifest } from "../shared/search.ts";

const file = (bytes: number) => ({ path: "x", sha256: "0", bytes });
const shard = (id: string, product: string, version: string, chunks: number, rows: number, bytes: number) => ({
  id,
  product,
  version,
  chunks,
  rows,
  meta: file(bytes),
  vec: file(bytes),
});
const m: Manifest = {
  index_format: 1,
  built_at: "2026-11-25T00:00:00Z",
  embedder: { id: "e", dtype: "q8", dims: 384, pooling: "cls", query_prefix: "" },
  shards: [
    shard("aap-2.6-docs-1", "aap", "2.6", 1500, 6000, 100),
    shard("ansible-core-2.22-docs-1", "ansible-core", "2.22", 1500, 7000, 200),
    shard("aap-2.6-docs-2", "aap", "2.6", 1647, 7911, 120),
    shard("ansible-core-2.22-plugins-1", "ansible-core", "2.22", 2514, 10759, 300),
  ],
  stats: { chunks: 7161, rows: 31670, bytes: 1440, enriched: 7161 },
};

test("doc sets are grouped by product, ansible-core first and required", () => {
  const sets = docSets(m);
  assert.deepEqual(sets.map((d) => [d.product, d.required, d.chunks, d.bytes]), [
    ["ansible-core", true, 4014, 1000],
    ["aap", false, 3147, 440],
  ]);
  assert.match(sets[1].label, /Red Hat Ansible Automation Platform/);
  assert.match(sets[1].credit, /CC BY-SA 4\.0/);
});

test("selecting shards keeps ansible-core and recounts the stats", () => {
  const core = selectShards(m, []);
  assert.deepEqual(productsOf(core), ["ansible-core"]);
  assert.deepEqual(core.stats, { chunks: 4014, rows: 17759, bytes: 1000, enriched: 4014 });
  const all = selectShards(m, ["aap", "unknown"]);
  assert.equal(all.shards.length, 4);
  assert.equal(all.stats.chunks, 7161);
  assert.equal(all.built_at, m.built_at);
});

test("default choice: everything on desktop, nothing optional on a phone", () => {
  assert.deepEqual(defaultChoice(m, false), ["aap"]);
  assert.deepEqual(defaultChoice(m, true), []);
});

test("saved choice survives garbage", () => {
  assert.equal(parseChoice(null), null);
  assert.equal(parseChoice("{bad"), null);
  assert.equal(parseChoice('{"a":1}'), null);
  assert.deepEqual(parseChoice('["aap", 3]'), ["aap"]);
});
