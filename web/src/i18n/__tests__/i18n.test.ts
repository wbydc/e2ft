import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectLang, fmtLeft, fmtRate, LANGS, setLang } from "../index.ts";

const html = readFileSync(new URL("../../../public/index.html", import.meta.url), "utf8");
const keys = [...html.matchAll(/data-i18n(?:-placeholder|-aria-label|-title)?="([^"]+)"/g)].map((m) => m[1]);

test("index.html names only plain-string keys that every language has", () => {
  assert.ok(keys.length > 20, `found ${keys.length} keys`);
  for (const [lang, messages] of Object.entries(LANGS)) {
    for (const key of keys) assert.equal(typeof (messages as Record<string, unknown>)[key], "string", `${lang}.${key}`);
  }
});

function withBrowser(saved: string | null, languages: string[], callback: () => void) {
  const globals = globalThis as Record<string, unknown>;
  const prev = { localStorage: globals.localStorage, navigator: globals.navigator };
  Object.defineProperty(globals, "localStorage", { value: { getItem: () => saved }, configurable: true });
  Object.defineProperty(globals, "navigator", { value: { languages, language: languages[0] }, configurable: true });
  try {
    callback();
  } finally {
    Object.defineProperty(globals, "localStorage", { value: prev.localStorage, configurable: true });
    Object.defineProperty(globals, "navigator", { value: prev.navigator, configurable: true });
  }
}

test("language: saved choice, then first known browser language, then English", () => {
  withBrowser(null, ["ru-RU", "en-US"], () => assert.equal(detectLang(), "ru"));
  withBrowser(null, ["de-DE", "ru"], () => assert.equal(detectLang(), "ru"));
  withBrowser(null, ["de-DE", "fr"], () => assert.equal(detectLang(), "en"));
  withBrowser("en", ["ru-RU"], () => assert.equal(detectLang(), "en"));
  withBrowser("xx", ["ru-RU"], () => assert.equal(detectLang(), "ru"));
});

test("time left: M:SS under an hour, H:MM:SS from one hour, seconds rounded up", () => {
  const cases: [number, string][] = [
    [0, "0:00"],
    [0.2, "0:01"],
    [59, "0:59"],
    [61, "1:01"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3661, "1:01:01"],
    [36000, "10:00:00"],
  ];
  for (const [secs, want] of cases) assert.equal(fmtLeft(secs), want, `${secs}s`);
});

test("speed: bytes or bits per second, stepping up at 1000, in English and Russian", () => {
  const globals = globalThis as Record<string, unknown>;
  Object.defineProperty(globals, "document", {
    value: { documentElement: {}, querySelectorAll: () => [] },
    configurable: true,
  });
  const cases = {
    en: [
      [999, "byte", "999 byte/s"],
      [1000, "byte", "1 kB/s"],
      [5_200_000, "byte", "5.2 MB/s"],
      [124.875, "bit", "999 bit/s"],
      [125, "bit", "1 kb/s"],
      [5_200_000, "bit", "41.6 Mb/s"],
    ],
    // CLDR writes a Latin "c" after the slash in Russian.
    ru: [
      [999, "byte", "999 Б/c"],
      [1000, "byte", "1 кБ/c"],
      [5_200_000, "byte", "5,2 МБ/c"],
      [124.875, "bit", "999 бит/c"],
      [125, "bit", "1 кбит/c"],
      [5_200_000, "bit", "41,6 Мбит/c"],
    ],
  } as const;
  try {
    for (const [lang, rows] of Object.entries(cases) as [keyof typeof cases, (typeof cases)[keyof typeof cases]][]) {
      setLang(lang);
      for (const [rate, unit, want] of rows)
        assert.equal(fmtRate(rate, unit).replace(/\s/g, " "), want, `${lang} ${rate} ${unit}`);
    }
  } finally {
    setLang("en");
    delete globals.document;
  }
});
