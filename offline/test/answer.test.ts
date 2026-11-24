import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt, citedNumbers, clip, isDeviceLost, isNotInDocs, PROFILES, stripInvalidCitations } from "../shared/answer.ts";
import type { Chunk } from "../shared/search.ts";

const chunk = (id: string, x: string): Chunk => ({ id, t: `Guide > Page > ${id}`, u: `https://docs.ansible.com/ansible/latest/${id}.html`, x, src: "docs", lic: "GPL-3.0-or-later" });

test("buildPrompt numbers passages, limits count and size, and skips duplicates", () => {
  const hits = [chunk("a", "x".repeat(5000)), chunk("a", "dup"), ...["b", "c", "d", "e", "f"].map((i) => chunk(i, "y".repeat(2000)))];
  const { messages, used } = buildPrompt("  how do I?  ", hits);
  assert.deepEqual(used.map((u) => u.n), [1, 2, 3]);
  assert.deepEqual(used.map((u) => u.chunk.id), ["a", "b", "c"]);
  const user = messages[1].content;
  assert.ok(user.endsWith("Question: how do I?"));
  assert.ok(user.length < PROFILES.normal.totalChars + 600, `prompt too long: ${user.length}`);
  const lite = buildPrompt("q", hits, PROFILES.lite);
  assert.equal(lite.used.length, 2);
  assert.ok(lite.messages[1].content.length < PROFILES.lite.totalChars + 600);
  assert.match(messages[0].content, /NOT_IN_DOCS/);
});

test("clip closes an open code fence and marks the cut", () => {
  const text = "intro\n\n```yaml\n- a: 1\n- b: 2\n" + "- c: 3\n".repeat(400);
  const out = clip(text, 300);
  assert.ok(out.length < 400);
  assert.equal((out.match(/```/g) ?? []).length % 2, 0);
  assert.ok(out.endsWith("[…]"));
  assert.equal(clip("short", PROFILES.normal.passageChars), "short");
});

test("NOT_IN_DOCS is recognised however the model decorates it", () => {
  for (const t of ["NOT_IN_DOCS", " not_in_docs.", "**NOT_IN_DOCS**", "`NOT_IN_DOCS`"]) assert.ok(isNotInDocs(t), t);
  assert.ok(!isNotInDocs("Use the copy module [1]."));
});

test("citations: only real passages count, invented ones are removed", () => {
  const { used } = buildPrompt("q", [chunk("a", "x"), chunk("b", "y")]);
  const answer = "Use copy [1] and also [2][1]. Invented [7] and [12].";
  assert.deepEqual(citedNumbers(answer, used), [1, 2]);
  assert.equal(stripInvalidCitations(answer, used), "Use copy [1] and also [2][1]. Invented and.");
});

test("GPU loss is told apart from ordinary errors", () => {
  assert.ok(isDeviceLost("Failed to execute 'mapAsync' on 'GPUBuffer': A valid external Instance reference no longer exists."));
  assert.ok(isDeviceLost("Device was lost"));
  assert.ok(isDeviceLost("Out of memory"));
  assert.ok(!isDeviceLost("Failed to fetch model config"));
});
