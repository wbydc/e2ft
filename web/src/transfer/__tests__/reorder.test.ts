import { test } from "node:test";
import assert from "node:assert/strict";
import { Reorder } from "../reorder.ts";

test("out-of-order chunks come out in order once the gap fills", () => {
  const reorder = new Reorder<string>(8);
  assert.equal(reorder.put(2, "c"), true);
  assert.equal(reorder.put(1, "b"), true);
  assert.deepEqual(reorder.take(), [], "index 0 is still missing");
  assert.equal(reorder.put(0, "a"), true);
  assert.deepEqual(reorder.take(), ["a", "b", "c"]);
  assert.equal(reorder.next, 3);
  assert.equal(reorder.put(4, "e"), true);
  assert.deepEqual(reorder.take(), []);
});

test("a duplicate, held or already taken, is refused and changes nothing", () => {
  const reorder = new Reorder<string>(8);
  reorder.put(1, "b");
  assert.equal(reorder.put(1, "x"), false);
  reorder.put(0, "a");
  assert.deepEqual(reorder.take(), ["a", "b"]);
  assert.equal(reorder.put(0, "x"), false);
  assert.equal(reorder.put(1, "x"), false);
  assert.deepEqual(reorder.take(), []);
});

test("an index at or past next + window throws; the last one inside is held", () => {
  const reorder = new Reorder<string>(4);
  assert.throws(() => reorder.put(4, "x"), /beyond the window/);
  assert.equal(reorder.put(3, "d"), true);
  reorder.put(0, "a");
  reorder.take();
  assert.equal(reorder.put(4, "e"), true, "the window moves with next");
  assert.throws(() => reorder.put(5, "x"), /beyond the window/);
});
