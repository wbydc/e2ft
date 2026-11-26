// Whether a transfer crawls enough to suggest Relay over TCP: some networks shape direct WebRTC traffic to a few
// hundred kB/s per connection, and TCP through the relay escapes it. Fed every progress update of both directions.
import type { Dir, Progress } from "../transfer/events.ts";
import { recentRate } from "../ui/room/progress.ts";

/** Below this recent rate (bytes per second) for SLOW_MS, past the WARMUP the time left also waits, a transfer is slow. */
const SLOW_RATE = 500_000;
const SLOW_MS = 10_000;
const WARMUP = 3000;
/** Samples as often as the progress rows render. */
const SAMPLE_MS = 250;

interface Watch {
  start: number;
  last: number;
  samples: [number, number][];
  /** Since when the rate stayed below SLOW_RATE with `lanes` connections. */
  slowSince: number;
  lanes: number;
}

export class SlowWatch {
  private readonly watches: Partial<Record<Dir, Watch>> = {};
  private fired = false;

  /** True once per room, when a running transfer stayed slow for SLOW_MS without its connection count changing (a
   *  transfer still adding connections may yet speed up). `eligible`: a TURN server is known and the room is not
   *  Relay over TCP already. A pause, a wait for the receiver or the end of a file starts the watch over. */
  public sample(dir: Dir, progress: Progress | null, lanes: number, now: number, eligible: boolean): boolean {
    if (!progress || progress.paused || progress.waiting) {
      delete this.watches[dir];

      return false;
    }
    if (this.fired || !eligible) return false;

    const watch = (this.watches[dir] ??= { start: now, last: -Infinity, samples: [], slowSince: now + WARMUP, lanes });
    if (now - watch.last < SAMPLE_MS) return false;

    watch.last = now;
    const rate = recentRate(watch.samples, now, progress.done);
    if (rate >= SLOW_RATE || lanes !== watch.lanes) {
      watch.slowSince = Math.max(now, watch.start + WARMUP);
      watch.lanes = lanes;
    }
    this.fired = now - watch.slowSince >= SLOW_MS;

    return this.fired;
  }
}
