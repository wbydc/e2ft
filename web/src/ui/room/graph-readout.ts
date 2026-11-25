// The speed at the pointer on a speed graph: a marker line and a label, on hover or while a finger presses and drags.
import { fmtRate } from "../../i18n/index.ts";
import { speedUnit } from "../speed-unit.ts";
import type { SpeedGraph } from "./speed-graph.ts";

/** Adds the readout to `box` (positioned, holding the graph); `graph` gives the graph to read, which may change. */
export function readGraph(box: HTMLElement, graph: () => SpeedGraph | undefined) {
  const marker = Object.assign(document.createElement("span"), { className: "graph-marker" });
  const label = Object.assign(document.createElement("span"), { className: "graph-label ui-num" });
  marker.setAttribute("aria-hidden", "true");
  label.setAttribute("aria-hidden", "true");
  box.append(marker, label);

  const hide = () => box.classList.remove("is-reading");
  const show = (event: PointerEvent) => {
    const rect = box.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const speed = graph()?.speedAt(fraction) ?? null;
    if (speed === null) {
      hide();

      return;
    }

    box.style.setProperty("--x", String(fraction));
    label.textContent = `${fmtRate(speed, speedUnit())} · ${Math.round(fraction * 100)}%`;
    box.classList.add("is-reading");
  };
  box.addEventListener("pointermove", show);
  box.addEventListener("pointerdown", show);
  box.addEventListener("pointerleave", hide);
  box.addEventListener("pointercancel", hide);
}
