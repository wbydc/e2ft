// Auto / Light / Dark: no data-theme on <html> means follow the system.
// public/theme.js applies the saved choice before first paint; this wires the one icon button that cycles it.
import { bindText } from "../i18n/index.ts";
import { burst } from "./motion.ts";
import { save } from "../store.ts";

type Theme = "auto" | "light" | "dark";
const NEXT: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };

/** `swap` is true for a click, not the first apply on load, so the icon turns only when the user asks. */
function apply(theme: Theme, button: HTMLElement, swap = false) {
  const root = document.documentElement;
  if (theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = theme;

  button.dataset.state = theme;
  if (swap) void burst(button, "is-swap");
  bindText(button, (m) => m.theme(theme === "auto" ? m.themeAuto : theme === "light" ? m.themeLight : m.themeDark), [
    "aria-label",
    "title",
  ]);

  // The browser chrome color follows a forced theme too, not only the system one.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = meta.dataset.scheme;
    meta.media = theme === "auto" ? `(prefers-color-scheme: ${scheme})` : scheme === theme ? "all" : "not all";
  }

  save("theme", theme === "auto" ? "" : theme);
}

export function setupTheme(button: HTMLElement) {
  const saved = document.documentElement.dataset.theme;
  apply(saved === "light" || saved === "dark" ? saved : "auto", button);
  button.addEventListener("click", () => apply(NEXT[button.dataset.state as Theme], button, true));
}
