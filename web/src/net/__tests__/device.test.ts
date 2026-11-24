import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NAME_MAX, cleanName, deviceLabel, parseDevice, randomName } from "../device.ts";

describe("device", () => {
  describe("randomName", () => {
    test("a random name is two capitalized words and passes its own bounds", () => {
      const names = Array.from({ length: 50 }, () => randomName());

      const badlyCased = names.filter((name) => !/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(name));
      const dirty = names.filter((name) => cleanName(name) !== name);

      assert.deepEqual(badlyCased, []);
      assert.deepEqual(dirty, []);
    });
  });

  describe("cleanName", () => {
    test("trims spaces around a name", () => {
      const name = cleanName("  Kitchen Laptop  ");

      assert.equal(name, "Kitchen Laptop");
    });

    test("replaces control characters with spaces", () => {
      const name = cleanName("a\nb\u0007c");

      assert.equal(name, "a b c");
    });

    test("replaces a right-to-left override with a space", () => {
      const name = cleanName("Otter\u202Egnp.exe");

      assert.equal(name, "Otter gnp.exe", "a right-to-left override");
    });

    test("cuts a long name to the server's limit in chars", () => {
      const name = cleanName("é".repeat(NAME_MAX + 5))!;

      assert.equal(Array.from(name).length, NAME_MAX);
    });

    test("drops the space left at the cut", () => {
      const name = cleanName("x".repeat(NAME_MAX - 1) + " tail");

      assert.equal(name, "x".repeat(NAME_MAX - 1), "no trailing space after the cut");
    });

    test("turns a blank name into null", () => {
      const names = ["", "   ", "\n\t"].map((empty) => cleanName(empty));

      assert.deepEqual(names, [null, null, null]);
    });

    test("turns a non-text name into null", () => {
      const names = [7, null, undefined].map((empty) => cleanName(empty));

      assert.deepEqual(names, [null, null, null]);
    });
  });

  describe("deviceLabel", () => {
    test("names the browser and system from the user agent", () => {
      const cases: [string, string][] = [
        ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", "Firefox, Linux"],
        [
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
          "Chrome, Windows",
        ],
        ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0", "Edge, Windows"],
        [
          "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
          "Chrome, Android",
        ],
        [
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
          "Safari, iOS",
        ],
        [
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
          "Safari, macOS",
        ],
        ["curl/8", "Browser"],
      ];

      const labels = cases.map(([userAgent]) => deviceLabel(userAgent));

      assert.deepEqual(
        labels,
        cases.map(([, label]) => label),
      );
    });
  });

  describe("parseDevice", () => {
    test("keeps a visible device with a trimmed name", () => {
      const device = parseDevice({ visible: true, name: " Den " });

      assert.deepEqual(device, { visible: true, name: "Den" });
    });

    test("hides an invalid saved device and replaces its name", () => {
      const raws = [null, "x", { visible: "yes", name: 5 }, { visible: 1 }];

      const devices = raws.map((raw) => parseDevice(raw));

      assert.deepEqual(
        devices.map((device) => device.visible),
        [false, false, false, false],
      );
      assert.deepEqual(
        devices.map((device) => cleanName(device.name)),
        devices.map((device) => device.name),
      );
    });
  });
});
