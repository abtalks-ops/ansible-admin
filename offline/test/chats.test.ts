import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CONVS, newConv, parse, remove, serialize, titleFrom, upsert, type Conv } from "../shared/chats.ts";

test("titles are trimmed, collapsed and capped", () => {
  assert.equal(titleFrom("  how   do I\nrun a handler? "), "how do I run a handler?");
  assert.equal(titleFrom("x".repeat(100)).length, 58);
  assert.equal(titleFrom("   "), "New chat");
});

test("upsert moves a conversation to the front and caps the list", () => {
  let list: Conv[] = [];
  for (let i = 0; i < MAX_CONVS + 5; i++) list = upsert(list, newConv(`c${i}`, i));
  assert.equal(list.length, MAX_CONVS);
  assert.equal(list[0].id, `c${MAX_CONVS + 4}`);
  const again = upsert(list, { ...list[10], title: "renamed" });
  assert.equal(again[0].title, "renamed");
  assert.equal(again.filter((c) => c.id === list[10].id).length, 1);
  assert.equal(remove(again, again[0].id).length, MAX_CONVS - 1);
});

test("serialize and parse round-trip", () => {
  const c = newConv("a", 5);
  c.turns.push({ q: "q1", hits: ["h1", "h2"], state: "done", answer: "A [1]", model: "m", stats: "s" });
  assert.deepEqual(parse(serialize([c])), [{ ...c, turns: [{ ...c.turns[0], note: undefined }] }]);
});

test("parse survives garbage", () => {
  assert.deepEqual(parse(null), []);
  assert.deepEqual(parse("{not json"), []);
  assert.deepEqual(parse('{"a":1}'), []);
  const out = parse(JSON.stringify([null, 5, { id: "x" }, { id: "y", turns: [null, { q: "ok", hits: ["a", 3], state: "weird" }, { q: "", hits: [] }] }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "y");
  assert.deepEqual(out[0].turns.map((t) => [t.q, t.hits, t.state]), [["ok", ["a"], "search"]]);
});
