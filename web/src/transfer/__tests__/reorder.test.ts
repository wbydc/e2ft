import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Reorder } from "../reorder.ts";

describe("Reorder", () => {
  describe("put", () => {
    test("accepts a chunk ahead of the next index", () => {
      const reorder = new Reorder<string>(8);

      const accepted = reorder.put(2, "c");

      assert.equal(accepted, true);
    });

    test("accepts a chunk that leaves a gap", () => {
      const reorder = new Reorder<string>(8);
      reorder.put(2, "c");

      const accepted = reorder.put(1, "b");

      assert.equal(accepted, true);
    });

    test("accepts a chunk that closes the gap", () => {
      const reorder = new Reorder<string>(8);
      reorder.put(2, "c");
      reorder.put(1, "b");

      const accepted = reorder.put(0, "a");

      assert.equal(accepted, true);
    });

    test("accepts a chunk after the held run was taken", () => {
      const reorder = new Reorder<string>(8);
      reorder.put(2, "c");
      reorder.put(1, "b");
      reorder.put(0, "a");
      reorder.take();

      const accepted = reorder.put(4, "e");

      assert.equal(accepted, true);
    });

    test("refuses a duplicate chunk still held", () => {
      const reorder = new Reorder<string>(8);
      reorder.put(1, "b");

      const accepted = reorder.put(1, "x");

      assert.equal(accepted, false);
    });

    test("refuses a chunk already taken", () => {
      const reorder = new Reorder<string>(8);
      reorder.put(1, "b");
      reorder.put(0, "a");
      reorder.take();

      const accepted = reorder.put(0, "x");

      assert.equal(accepted, false);
    });

    test("refuses a later chunk of a run already taken", () => {
      const reorder = new Reorder<string>(8);
      reorder.put(1, "b");
      reorder.put(0, "a");
      reorder.take();

      const accepted = reorder.put(1, "x");

      assert.equal(accepted, false);
    });

    test("throws at an index at or past next plus the window", () => {
      const reorder = new Reorder<string>(4);

      assert.throws(() => reorder.put(4, "x"), /beyond the window/);
    });

    test("holds the last index inside the window", () => {
      const reorder = new Reorder<string>(4);

      const accepted = reorder.put(3, "d");

      assert.equal(accepted, true);
    });

    describe("after next moves", () => {
      test("accepts the first index of the moved window", () => {
        const reorder = new Reorder<string>(4);
        reorder.put(0, "a");
        reorder.take();

        const accepted = reorder.put(4, "e");

        assert.equal(accepted, true, "the window moves with next");
      });

      test("throws at the first index past the moved window", () => {
        const reorder = new Reorder<string>(4);
        reorder.put(0, "a");
        reorder.take();

        assert.throws(() => reorder.put(5, "x"), /beyond the window/);
      });
    });
  });

  describe("take", () => {
    test("returns nothing while the first index is missing", () => {
      const reorder = new Reorder<string>(8);
      reorder.put(2, "c");
      reorder.put(1, "b");

      const taken = reorder.take();

      assert.deepEqual(taken, [], "index 0 is still missing");
    });

    test("returns the held run in order and moves next past it", () => {
      const reorder = new Reorder<string>(8);
      reorder.put(2, "c");
      reorder.put(1, "b");
      reorder.put(0, "a");

      const taken = reorder.take();
      const next = reorder.next;

      assert.deepEqual(taken, ["a", "b", "c"]);
      assert.equal(next, 3);
    });

    test("returns nothing when the next index is missing", () => {
      const reorder = new Reorder<string>(8);
      reorder.put(2, "c");
      reorder.put(1, "b");
      reorder.put(0, "a");
      reorder.take();
      reorder.put(4, "e");

      const taken = reorder.take();

      assert.deepEqual(taken, []);
    });

    test("returns two held chunks in order", () => {
      const reorder = new Reorder<string>(8);
      reorder.put(1, "b");
      reorder.put(0, "a");

      const taken = reorder.take();

      assert.deepEqual(taken, ["a", "b"]);
    });

    test("returns nothing once the run was already taken", () => {
      const reorder = new Reorder<string>(8);
      reorder.put(1, "b");
      reorder.put(0, "a");
      reorder.take();

      const taken = reorder.take();

      assert.deepEqual(taken, []);
    });
  });
});
