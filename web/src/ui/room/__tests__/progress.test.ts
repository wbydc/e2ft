import { test } from "node:test";
import assert from "node:assert/strict";
import { recentRate } from "../progress.ts";

test("the first render has no rate yet", () => {
  assert.equal(recentRate([], 1000, 0), 0);
});

test("a steady rate shows that rate", () => {
  const samples: [number, number][] = [];
  let rate = 0;
  for (let time = 0; time <= 20_000; time += 250) rate = recentRate(samples, time, time * 1000);
  assert.equal(rate, 1_000_000);
});

test("bytes moved before the last 8 seconds do not count", () => {
  const samples: [number, number][] = [];
  recentRate(samples, 0, 0);
  recentRate(samples, 1000, 50_000_000);
  for (let time = 1250; time <= 12_000; time += 250) recentRate(samples, time, 50_000_000 + (time - 1000) * 100);
  assert.equal(recentRate(samples, 12_250, 50_000_000 + 11_250 * 100), 100_000);
});
