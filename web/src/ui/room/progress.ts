// The sending and receiving rows: bar, name, bytes, rate and time left, and Fun mode's end-of-transfer burst.
import { bindText, fmtBytes, fmtLeft, fmtRate } from "../../i18n/index.ts";
import type { Dir, Finished, Progress } from "../../transfer/events.ts";
import { $ } from "../dom.ts";
import { burst, isLively } from "../motion.ts";
import { speedUnit } from "../speed-unit.ts";

/** `samples` holds the rendered `[time, done]` pairs of the last WINDOW ms, for the recent rate behind speed and time left. */
const rates: Partial<Record<Dir, { start: number; last: number; samples: [number, number][] }>> = {};
/** Speed and time left use the rate over this window, which follows lanes being added; the time left waits WARMUP. */
const WINDOW = 8000;
const WARMUP = 3000;
const glides: Partial<Record<Dir, number>> = {};
const bursts: Record<Dir, number> = { out: 0, in: 0 };

/** Adds the render `[now, done]` to `samples`, drops those older than WINDOW and returns bytes per second over the rest. */
export function recentRate(samples: [number, number][], now: number, done: number): number {
  samples.push([now, done]);
  while (now - samples[0][0] > WINDOW) samples.shift();

  const [firstTime, firstDone] = samples[0];

  return now > firstTime ? ((done - firstDone) / (now - firstTime)) * 1000 : 0;
}

/** Eases the bar to `to` over `ms`, so it moves between the 4-a-second renders instead of stepping; a drop snaps. */
function glide(dir: Dir, to: number, duration: number) {
  const bar = $<HTMLProgressElement>(`${dir}-bar`);
  const track = $(`${dir}-track`);
  // Fun mode's spell beam is clipped to the fill and its orb rides the edge.
  const set = (value: number) => {
    bar.value = value;
    if (isLively()) track.style.setProperty("--p", String(value));
  };
  cancelAnimationFrame(glides[dir] ?? 0);
  const from = bar.value;
  if (to <= from || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    set(to);

    return;
  }

  const start = performance.now();
  const step = (now: number) => {
    const fraction = Math.min(1, (now - start) / duration);
    set(from + (to - from) * fraction);
    if (fraction < 1) glides[dir] = requestAnimationFrame(step);
  };
  glides[dir] = requestAnimationFrame(step);
}

/** Renders a transfer row at most 4 times a second, plus its first and last update. */
export function showProgress(dir: Dir, progress: Progress | null) {
  const row = $(`${dir}-row`);
  if (!progress) {
    delete rates[dir];
    row.classList.remove("is-waiting");
    // A finished() right after this may keep the row up for its Fun mode burst.
    queueMicrotask(() => {
      if (!rates[dir] && !bursts[dir]) row.hidden = true;
    });

    return;
  }
  if (progress.paused) {
    // The rate starts over on resume; Fun mode holds its beam still meanwhile.
    delete rates[dir];
    row.hidden = false;
    row.classList.add("is-waiting");
    $(`${dir}-name`).textContent = progress.name;
    glide(dir, progress.total ? progress.done / progress.total : 1, 0);
    bindText($(`${dir}-text`), (m) => `${m.progress(fmtBytes(progress.done), fmtBytes(progress.total))} · ${m.paused}`);

    return;
  }

  const now = performance.now();
  if (progress.done === 0 || !rates[dir]) rates[dir] = { start: now, last: 0, samples: [] };
  const rate = rates[dir];
  if (progress.done !== 0 && progress.done !== progress.total && now - rate.last < 250) return;
  const gap = Math.min(1000, now - rate.last);
  rate.last = now;
  // Accept does not animate the closing offer; the package zips into the receiving bar as it appears.
  const first = dir === "in" && progress.done === 0 && row.hidden;
  row.hidden = false;
  // The Fun mode beam waits for the receiver's accept, not the offer.
  row.classList.toggle("is-waiting", !!progress.waiting);
  if (first) void burst(row, "is-zip");
  $(`${dir}-name`).textContent = progress.name;
  glide(dir, progress.total ? progress.done / progress.total : 1, gap);

  const { done, total } = progress;
  const recent = recentRate(rate.samples, now, done);
  const left =
    !progress.waiting && now - rate.start >= WARMUP && recent > 0 && done < total ? (total - done) / recent : null;

  bindText($(`${dir}-text`), (messages) => {
    const speed = recent > 0 ? ` · ${fmtRate(recent, speedUnit())}` : "";
    const timeLeft = left === null ? "" : ` · ${messages.timeLeft(fmtLeft(left))}`;

    return messages.progress(fmtBytes(done), fmtBytes(total)) + speed + timeLeft;
  });
}

/** Fun mode: a done transfer shakes, a cancelled or failed one fizzles, then its row hides. */
export function flourish(finished: Finished) {
  const row = $(`${finished.dir}-row`);
  if (!isLively() || finished.outcome === "declined" || row.hidden) return;

  bursts[finished.dir]++;
  void burst(row, finished.outcome === "done" ? "is-done" : "is-fizzle").then(() => {
    if (--bursts[finished.dir] === 0 && !rates[finished.dir]) row.hidden = true;
  });
}
