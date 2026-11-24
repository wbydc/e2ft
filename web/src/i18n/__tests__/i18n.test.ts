import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectLang, fmtLeft, fmtRate, LANGS, setLang } from "../index.ts";
import type { SpeedUnit } from "../index.ts";

const html = readFileSync(new URL("../../../public/index.html", import.meta.url), "utf8");
const keys = [...html.matchAll(/data-i18n(?:-placeholder|-aria-label|-title)?="([^"]+)"/g)].map((m) => m[1]);

const globals = globalThis as Record<string, unknown>;
let previous: { localStorage: unknown; navigator: unknown; document: unknown };

const restoreGlobal = (name: string, value: unknown) => {
  if (value === undefined) delete globals[name];
  else Object.defineProperty(globals, name, { value, configurable: true });
};

const useBrowser = (saved: string | null, languages: string[]) => {
  Object.defineProperty(globals, "localStorage", { value: { getItem: () => saved }, configurable: true });
  Object.defineProperty(globals, "navigator", { value: { languages, language: languages[0] }, configurable: true });
};

const useDocument = () => {
  Object.defineProperty(globals, "document", {
    value: { documentElement: {}, querySelectorAll: () => [] },
    configurable: true,
  });
};

type RateCase = [rate: number, unit: SpeedUnit, want: string];

const leftMismatches = (cases: [number, string][]) =>
  cases
    .map(([secs, want]) => ({ secs, want, got: fmtLeft(secs) }))
    .filter(({ want, got }) => got !== want)
    .map(({ secs, want, got }) => `${secs}s: want ${want}, got ${got}`);

const rateMismatches = (lang: string, cases: RateCase[]) =>
  cases
    .map(([rate, unit, want]) => ({
      label: `${lang} ${rate} ${unit}`,
      want,
      got: fmtRate(rate, unit).replace(/\s/g, " "),
    }))
    .filter(({ want, got }) => got !== want)
    .map(({ label, want, got }) => `${label}: want ${want}, got ${got}`);

beforeEach(() => {
  previous = { localStorage: globals.localStorage, navigator: globals.navigator, document: globals.document };
});

afterEach(() => {
  if (globals.document !== undefined) setLang("en");
  restoreGlobal("localStorage", previous.localStorage);
  restoreGlobal("navigator", previous.navigator);
  restoreGlobal("document", previous.document);
});

describe("i18n", () => {
  describe("LANGS", () => {
    describe("the keys index.html names", () => {
      test("are plain strings in every language", () => {
        const missing = Object.entries(LANGS).flatMap(([lang, messages]) =>
          keys
            .filter((key) => typeof (messages as Record<string, unknown>)[key] !== "string")
            .map((key) => `${lang}.${key}`),
        );

        assert.ok(keys.length > 20, `found ${keys.length} keys`);
        assert.deepEqual(missing, [], `missing messages: ${missing.join(", ")}`);
      });
    });
  });

  describe("detectLang", () => {
    describe("with no saved choice", () => {
      test("uses the first known browser language", () => {
        useBrowser(null, ["ru-RU", "en-US"]);

        const lang = detectLang();

        assert.equal(lang, "ru");
      });

      test("skips unknown browser languages", () => {
        useBrowser(null, ["de-DE", "ru"]);

        const lang = detectLang();

        assert.equal(lang, "ru");
      });

      test("falls back to English", () => {
        useBrowser(null, ["de-DE", "fr"]);

        const lang = detectLang();

        assert.equal(lang, "en");
      });
    });

    describe("with a saved choice", () => {
      test("uses it", () => {
        useBrowser("en", ["ru-RU"]);

        const lang = detectLang();

        assert.equal(lang, "en");
      });

      test("ignores an unknown saved choice", () => {
        useBrowser("xx", ["ru-RU"]);

        const lang = detectLang();

        assert.equal(lang, "ru");
      });
    });
  });

  describe("fmtLeft", () => {
    describe("under an hour", () => {
      test("is M:SS with seconds rounded up", () => {
        const cases: [number, string][] = [
          [0, "0:00"],
          [0.2, "0:01"],
          [59, "0:59"],
          [61, "1:01"],
          [3599, "59:59"],
        ];

        const mismatches = leftMismatches(cases);

        assert.deepEqual(mismatches, []);
      });
    });

    describe("from one hour", () => {
      test("is H:MM:SS with seconds rounded up", () => {
        const cases: [number, string][] = [
          [3600, "1:00:00"],
          [3661, "1:01:01"],
          [36000, "10:00:00"],
        ];

        const mismatches = leftMismatches(cases);

        assert.deepEqual(mismatches, []);
      });
    });
  });

  describe("fmtRate", () => {
    describe("in English", () => {
      test("reports bytes per second, stepping up at 1000", () => {
        useDocument();
        setLang("en");
        const cases: RateCase[] = [
          [999, "byte", "999 byte/s"],
          [1000, "byte", "1 kB/s"],
          [5_200_000, "byte", "5.2 MB/s"],
        ];

        const mismatches = rateMismatches("en", cases);

        assert.deepEqual(mismatches, []);
      });

      test("reports bits per second, stepping up at 1000", () => {
        useDocument();
        setLang("en");
        const cases: RateCase[] = [
          [124.875, "bit", "999 bit/s"],
          [125, "bit", "1 kb/s"],
          [5_200_000, "bit", "41.6 Mb/s"],
        ];

        const mismatches = rateMismatches("en", cases);

        assert.deepEqual(mismatches, []);
      });
    });

    describe("in Russian", () => {
      test("reports bytes per second, stepping up at 1000", () => {
        useDocument();
        setLang("ru");
        // CLDR writes a Latin "c" after the slash in Russian.
        const cases: RateCase[] = [
          [999, "byte", "999 Б/c"],
          [1000, "byte", "1 кБ/c"],
          [5_200_000, "byte", "5,2 МБ/c"],
        ];

        const mismatches = rateMismatches("ru", cases);

        assert.deepEqual(mismatches, []);
      });

      test("reports bits per second, stepping up at 1000", () => {
        useDocument();
        setLang("ru");
        const cases: RateCase[] = [
          [124.875, "bit", "999 бит/c"],
          [125, "bit", "1 кбит/c"],
          [5_200_000, "bit", "41,6 Мбит/c"],
        ];

        const mismatches = rateMismatches("ru", cases);

        assert.deepEqual(mismatches, []);
      });
    });
  });
});
