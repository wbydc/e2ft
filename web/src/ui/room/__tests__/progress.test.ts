import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { recentRate } from "../progress.ts";

describe("progress", () => {
  describe("recentRate", () => {
    test("is 0 on the first render", () => {
      const samples: [number, number][] = [];

      const rate = recentRate(samples, 1000, 0);

      assert.equal(rate, 0);
    });

    test("shows a steady rate", () => {
      const samples: [number, number][] = [];
      let rate = 0;
      for (let time = 0; time <= 20_000; time += 250) rate = recentRate(samples, time, time * 1000);

      assert.equal(rate, 1_000_000);
    });

    test("counts only bytes moved in the last 8 seconds", () => {
      const samples: [number, number][] = [];
      recentRate(samples, 0, 0);
      recentRate(samples, 1000, 50_000_000);
      for (let time = 1250; time <= 12_000; time += 250) recentRate(samples, time, 50_000_000 + (time - 1000) * 100);

      const rate = recentRate(samples, 12_250, 50_000_000 + 11_250 * 100);

      assert.equal(rate, 100_000);
    });
  });
});
