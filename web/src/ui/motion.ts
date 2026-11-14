// Lively animations (Fun mode), on unless the Calm setting is on; saved in this browser only.
// The <html> class "fun" marks it on. public/theme.js applies the saved choice before
// first paint, turning it off under reduce-motion when nothing is saved; this toggles it and plays one-shot effects.
import { save } from "../store.ts";

export const isLively = () => document.documentElement.classList.contains("fun");

export function setLively(on: boolean) {
  document.documentElement.classList.toggle("fun", on);
  save("calm", on ? "0" : "1");
}

/** Plays a one-shot class on `el` and resolves when its own animations settle; at once when Fun mode is off. */
export async function burst(element: Element, className: string): Promise<void> {
  if (!isLively()) return;

  element.classList.remove(className);
  element.getBoundingClientRect(); // restart the animation when the class was already there
  element.classList.add(className);

  await Promise.allSettled(element.getAnimations().map((a) => a.finished));
  element.classList.remove(className);
}
