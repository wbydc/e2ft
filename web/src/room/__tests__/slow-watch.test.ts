import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SlowWatch } from "../slow-watch.ts";

/** Feeds `watch` a transfer at `rate` bytes per second, every 250 ms from `from` to `to` ms, and returns the times
 *  it fired. `lanes` gives the connection count at each time. */
function feed(
  watch: SlowWatch,
  rate: number,
  {
    from = 0,
    to = 20_000,
    lanes = () => 1,
    eligible = true,
  }: Partial<{
    from: number;
    to: number;
    lanes: (time: number) => number;
    eligible: boolean;
  }> = {},
): number[] {
  const fired: number[] = [];
  for (let time = from; time <= to; time += 250) {
    const progress = { name: "f", done: Math.round(((time - from) * rate) / 1000), total: 1e12 };
    if (watch.sample("out", progress, lanes(time), time, eligible)) fired.push(time);
  }

  return fired;
}

describe("SlowWatch", () => {
  describe("sample", () => {
    test("fires once, 10 s after the 3 s warm-up, for a transfer under 500 kB/s", () => {
      const watch = new SlowWatch();

      const fired = feed(watch, 200_000);

      assert.deepEqual(fired, [13_000]);
    });

    test("never fires for a transfer at 500 kB/s or more", () => {
      const watch = new SlowWatch();

      const fired = feed(watch, 500_000, { to: 60_000 });

      assert.deepEqual(fired, []);
    });

    test("waits while the connection count still changes", () => {
      const watch = new SlowWatch();

      const fired = feed(watch, 200_000, { to: 30_000, lanes: (time) => Math.min(4, 1 + Math.floor(time / 4000)) });

      assert.deepEqual(fired, [22_000], "the last connection came at 12 s");
    });

    test("never fires when not eligible: no TURN server, or the room is Relay over TCP already", () => {
      const watch = new SlowWatch();

      const fired = feed(watch, 200_000, { to: 60_000, eligible: false });

      assert.deepEqual(fired, []);
    });

    test("does not fire again in the same room, also for a later slow file", () => {
      const watch = new SlowWatch();
      feed(watch, 200_000);
      watch.sample("out", null, 1, 20_250, true);

      const fired = feed(watch, 200_000, { from: 30_000, to: 60_000 });

      assert.deepEqual(fired, []);
    });

    test("starts over after a pause", () => {
      const watch = new SlowWatch();
      feed(watch, 200_000, { to: 12_000 });
      watch.sample("out", { name: "f", done: 1, total: 1e12, paused: true }, 1, 12_250, true);

      const fired = feed(watch, 200_000, { from: 20_000, to: 40_000 });

      assert.deepEqual(fired, [33_000]);
    });
  });
});
