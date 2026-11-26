import assert from "node:assert/strict";
import { test } from "node:test";
import { pack, splitLong } from "../pipeline/chunk.ts";
import { CHUNK_MAX_CHARS } from "../pipeline/config.ts";

const fences = (s: string) => s.split("\n").filter((l) => l.startsWith("```")).length;

test("a long code block is split at line breaks, and each piece is a closed fence", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `    - name: task number ${i} with a fairly long line`);
  const body = "Intro paragraph.\n\n```yaml\n" + lines.join("\n") + "\n```";
  const pieces = pack(body);
  assert.ok(pieces.length > 2);
  const all = new Set(lines);
  for (const p of pieces) {
    assert.ok(p.length <= CHUNK_MAX_CHARS * 1.5, `piece of ${p.length} chars`);
    assert.equal(fences(p) % 2, 0, "fence left open");
    for (const l of p.split("\n")) if (l.startsWith("    - ")) assert.ok(all.has(l), `cut line: ${JSON.stringify(l)}`);
  }
  // Every line survives, in order, exactly once.
  const got = pieces.flatMap((p) => p.split("\n")).filter((l) => l.startsWith("    - "));
  assert.deepEqual(got, lines);
  assert.ok(pieces.slice(1).every((p) => p.startsWith("```yaml\n")), "reopened with the language");
});

test("splitLong prefers a blank line, keeps indentation, and falls back to a space", () => {
  const a = "x".repeat(1200) + "\n\n" + "  y".repeat(500);
  const [h, t] = splitLong(a, 1800);
  assert.equal(h, "x".repeat(1200));
  assert.ok(t.startsWith("  y"));
  const words = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
  const [h2, t2] = splitLong(words, 1800);
  assert.ok(h2.length <= 1800);
  assert.equal(`${h2} ${t2}`, words);
});
