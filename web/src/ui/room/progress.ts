// The sending and receiving rows: speed graph, name, bytes, rate and time left, and Fun mode's end-of-transfer burst.
import { bindText, fmtBytes, fmtLeft, fmtRate } from "../../i18n/index.ts";
import type { Dir, Finished, Progress } from "../../transfer/events.ts";
import { $ } from "../dom.ts";
import { burst, isLively } from "../motion.ts";
import { speedUnit } from "../speed-unit.ts";
import { SpeedGraph } from "./speed-graph.ts";

/** `samples` holds the rendered `[time, done]` pairs of the last WINDOW ms, for the recent rate behind speed and time left. */
const rates: Partial<Record<Dir, { start: number; last: number; samples: [number, number][] }>> = {};
/** Speed and time left use the rate over this window, which follows lanes being added; the time left waits WARMUP. */
const WINDOW = 8000;
const WARMUP = 3000;
/** Each row's graph, kept over a pause and replaced when a new file starts. */
const graphs: Partial<Record<Dir, SpeedGraph>> = {};
const glides: Partial<Record<Dir, number>> = {};
const bursts: Record<Dir, number> = { out: 0, in: 0 };

/** Adds the render `[now, done]` to `samples`, drops those older than WINDOW and returns bytes per second over the rest. */
export function recentRate(samples: [number, number][], now: number, done: number): number {
  samples.push([now, done]);
  while (now - samples[0][0] > WINDOW) samples.shift();

  const [firstTime, firstDone] = samples[0];

  return now > firstTime ? ((done - firstDone) / (now - firstTime)) * 1000 : 0;
}

/** Eases the bar and the graph's edge to `to` over `ms`, so they move between the 4-a-second renders instead of stepping; a drop snaps. */
function glide(dir: Dir, to: number, duration: number) {
  const bar = $<HTMLProgressElement>(`${dir}-bar`);
  const track = $(`${dir}-track`);
  // The graph is clipped to the fill and Fun mode's orb rides its edge.
  const set = (value: number) => {
    bar.value = value;
    track.style.setProperty("--p", String(value));
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

/** Adds the speed since the `previous` render to the row's graph and redraws it; the first render after a start or resume has none. */
function drawGraph(dir: Dir, fraction: number, previous: [number, number] | undefined, now: number, done: number) {
  let graph = graphs[dir];
  if (!graph || fraction < graph.fraction) graph = graphs[dir] = new SpeedGraph();
  if (previous && now > previous[0]) graph.add(fraction, ((done - previous[1]) / (now - previous[0])) * 1000);

  $(`${dir}-graph`).setAttribute("d", graph.path());
  $(`${dir}-track`).style.setProperty("--h", String(graph.height()));
}

/** The row's graph as last drawn, for the history row; a new file clears it on its first render. */
export function drawnGraph(dir: Dir): string {
  return $(`${dir}-graph`).getAttribute("d") ?? "";
}

/** Renders a transfer row at most 4 times a second, plus its first and last update. */
export function showProgress(dir: Dir, progress: Progress | null) {
  const row = $(`${dir}-row`);
  if (!progress) {
    delete rates[dir];
    delete graphs[dir];
    row.classList.remove("is-waiting");
    // A finished() right after this may keep the row up for its Fun mode burst.
    queueMicrotask(() => {
      if (!rates[dir] && !bursts[dir]) row.hidden = true;
    });

    return;
  }
  if (progress.paused) {
    // The rate starts over on resume and the graph is kept; Fun mode holds its orb still meanwhile.
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
  const { done, total } = progress;
  const fraction = total ? done / total : 1;
  glide(dir, fraction, gap);
  drawGraph(dir, fraction, rate.samples.at(-1), now, done);

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
