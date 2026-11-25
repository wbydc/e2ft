// The room's list of finished transfers, newest first; a row with a speed graph unfolds it on click.
import { bindText, fmtBytes } from "../../i18n/index.ts";
import type { Text } from "../../i18n/index.ts";
import type { Finished } from "../../transfer/events.ts";
import { heldFile, saveHeld } from "../../transfer/save.ts";
import { $ } from "../dom.ts";
import { burst, isLively } from "../motion.ts";
import { setStatus } from "../status.ts";
import { drawnGraph } from "./progress.ts";

/** Incoming files kept in OPFS (iOS) until the user taps Save in their history row: transfer id to OPFS file name. */
export const held = new Map<string, string>();

const ARROW = {
  out: '<path d="M12 5l0 14"/><path d="M18 11l-6 -6"/><path d="M6 11l6 -6"/>',
  in: '<path d="M12 5l0 14"/><path d="M18 13l-6 6"/><path d="M6 13l6 6"/>',
};
// Fun mode only: a done row's check draws itself. With Fun mode off the row keeps today's markup.
const CHECK =
  '<svg class="hist-check" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
const CHEVRON =
  '<svg class="ui-icon hist-chevron" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6l6 -6"/></svg>';
const SVG = "http://www.w3.org/2000/svg";
const OUTCOME: Record<Finished["outcome"], Text> = {
  done: (m) => m.histDone,
  declined: (m) => m.histDeclined,
  cancelled: (m) => m.histCancelled,
  failed: (m) => m.histFailed,
};

/** Newest first. A transfer that drew a speed graph keeps it folded under the row, a native disclosure the click opens. A held file gets a Save button; its File is fetched now so the tap can open the share sheet at once. */
export function addHistory(finished: Finished) {
  const item = document.createElement("li");
  item.className = `hist hist--${finished.outcome}`;
  item.innerHTML = `<svg class="ui-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ARROW[finished.dir]}</svg>`;

  const dirText = document.createElement("span");
  dirText.className = "visually-hidden";
  bindText(dirText, (m) => (finished.dir === "out" ? m.histOut : m.histIn));
  const name = Object.assign(document.createElement("span"), {
    className: "hist-name ui-truncate",
    textContent: finished.name,
  });
  const size = Object.assign(document.createElement("span"), { className: "ui-num ui-muted" });
  bindText(size, () => fmtBytes(finished.size));
  const state = Object.assign(document.createElement("span"), { className: "hist-state" });
  bindText(state, OUTCOME[finished.outcome]);
  item.append(dirText, name, size, state);

  if (isLively() && finished.outcome === "done") item.insertAdjacentHTML("beforeend", CHECK);
  const graph = finished.outcome === "declined" ? "" : drawnGraph(finished.dir);
  if (graph) foldGraph(item, graph);
  const heldName = finished.dir === "in" && finished.outcome === "done" ? held.get(finished.id) : undefined;
  if (heldName) {
    const button = Object.assign(document.createElement("button"), {
      type: "button",
      className: "ui-btn ui-btn--sm",
      disabled: true,
    });
    bindText(button, (m) => m.saveHeld);
    item.append(button);

    void heldFile(heldName, finished.name, finished.type).then((file) => {
      button.disabled = false;
      button.addEventListener("click", () => saveHeld(file));
    });

    setStatus((m) => m.receivedHeld(finished.name), "success");
  }

  $("history").prepend(item);
  $("history-box").hidden = false;
  void burst(item, "is-land"); // Fun mode: the finished file lands in the list.
}

/** Moves the row's content into a `<summary>` and puts the graph in its `<details>`, folded. */
function foldGraph(item: HTMLLIElement, graph: string) {
  const details = Object.assign(document.createElement("details"), { className: "hist-details" });
  const summary = Object.assign(document.createElement("summary"), { className: "hist-summary" });
  summary.append(...item.childNodes);
  summary.insertAdjacentHTML("beforeend", CHEVRON);

  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "hist-graph");
  svg.setAttribute("viewBox", "0 0 100 40");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", graph);
  path.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(path);

  details.append(summary, svg);
  item.append(details);
}
