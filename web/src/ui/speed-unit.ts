// Transfer speed in bytes or bits per second, saved in this browser only; bytes unless bits was chosen.
// Kept in memory too, so a click still flips it when storage is blocked.
import { renderBound } from "../i18n/index.ts";
import type { SpeedUnit } from "../i18n/index.ts";
import { load, save } from "../store.ts";

let unit: SpeedUnit = load("speedUnit") === "bit" ? "bit" : "byte";

export const speedUnit = () => unit;

/** Saves the choice and redraws the texts that show a speed. */
export function setSpeedUnit(next: SpeedUnit) {
  unit = next;
  save("speedUnit", unit);
  renderBound();
}

/** A click on a transfer's progress text. */
export const flipSpeedUnit = () => setSpeedUnit(unit === "bit" ? "byte" : "bit");
