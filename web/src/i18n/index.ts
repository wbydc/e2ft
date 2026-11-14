// UI language. One dictionary per file in this folder; add a language by adding a file and an entry in LANGS.
// Static markup names its text with data-i18n / data-i18n-placeholder / data-i18n-aria-label; dynamic text is a
// `Text` bound to its element, so switching language re-renders both.
import en from "./en.ts";
import type { Messages } from "./en.ts";
import ru from "./ru.ts";
import * as store from "../store.ts";

export type { Messages };
export type Text = (m: Messages) => string;

export const LANGS = { en, ru } satisfies Record<string, Messages>;
export type Lang = keyof typeof LANGS;

const isLang = (l: string | null): l is Lang => l !== null && Object.hasOwn(LANGS, l);

/** Saved choice, else the first browser language we have, else English. */
export function detectLang(): Lang {
  const saved = store.load("lang");
  if (isLang(saved)) return saved;

  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split("-")[0];
    if (isLang(base)) return base;
  }

  return "en";
}

let lang: Lang = "en";
const bound = new Map<HTMLElement, { text: Text; attrs: readonly string[] }>();

export const currentLang = () => lang;
/** Text in the current language now, for a notification that does not follow a later language switch. */
export const translate = (text: Text) => text(LANGS[lang]);

function render(element: HTMLElement, text: Text, attrs: readonly string[]) {
  const value = text(LANGS[lang]);
  if (attrs.length) for (const attr of attrs) element.setAttribute(attr, value);
  else element.textContent = value;
}

/** Sets an element's text (or the given attributes) now and again on every language switch. */
export function bindText(element: HTMLElement, text: Text, attrs: readonly string[] = []) {
  bound.set(element, { text, attrs });
  render(element, text, attrs);
}

type StaticKey = { [K in keyof Messages]: Messages[K] extends string ? K : never }[keyof Messages];
const ATTRS = [
  ["data-i18n-placeholder", "placeholder"],
  ["data-i18n-aria-label", "aria-label"],
  ["data-i18n-title", "title"],
] as const;

export function setLang(next: Lang, save = false) {
  lang = next;
  const messages = LANGS[lang];
  document.documentElement.lang = lang;
  document.title = messages.title;

  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]"))
    element.textContent = messages[element.dataset.i18n as StaticKey];
  for (const [data, attr] of ATTRS) {
    for (const element of document.querySelectorAll(`[${data}]`))
      element.setAttribute(attr, messages[element.getAttribute(data) as StaticKey]);
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[data-legal]")) {
    const page = link.dataset.legal;
    if (page === "terms" || page === "privacy")
      link.setAttribute("href", lang === "en" ? `/${page}` : `/${page}?lang=${lang}`);
  }
  for (const [element, { text, attrs }] of bound) render(element, text, attrs);

  if (save) store.save("lang", lang);
}

/** Fills the language <select> and switches on change. */
export function setupLang(select: HTMLSelectElement) {
  for (const [code, messages] of Object.entries(LANGS)) select.add(new Option(messages.langName, code));

  setLang(detectLang());
  select.value = lang;
  select.addEventListener("change", () => isLang(select.value) && setLang(select.value, true));
}

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];

/** Decimal units, localized ("1.5 MB", "1,5 МБ"). */
export function fmtBytes(bytes: number): string {
  let unit = 0;
  while (bytes >= 1000 && unit < BYTE_UNITS.length - 1) {
    bytes /= 1000;
    unit++;
  }

  return new Intl.NumberFormat(lang, {
    style: "unit",
    unit: BYTE_UNITS[unit],
    maximumFractionDigits: unit ? 1 : 0,
  }).format(bytes);
}

/** Time left as M:SS, or H:MM:SS from one hour, whole seconds rounded up. */
export function fmtLeft(secs: number): string {
  const total = Math.ceil(secs);
  const mmss = `${Math.floor(total / 60) % 60}:${String(total % 60).padStart(2, "0")}`;

  return total < 3600 ? mmss : `${Math.floor(total / 3600)}:${mmss.padStart(5, "0")}`;
}
