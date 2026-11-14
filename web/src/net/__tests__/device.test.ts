import { test } from "node:test";
import assert from "node:assert/strict";
import { NAME_MAX, cleanName, deviceLabel, parseDevice, randomName } from "../device.ts";

test("a random name is two capitalized words and passes its own bounds", () => {
  for (let i = 0; i < 50; i++) {
    const name = randomName();
    assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.equal(cleanName(name), name);
  }
});

test("names are trimmed, cut to the server's limit in chars and stripped of control characters", () => {
  assert.equal(cleanName("  Kitchen Laptop  "), "Kitchen Laptop");
  assert.equal(cleanName("a\nb\u0007c"), "a b c");
  assert.equal(cleanName("Otter\u202Egnp.exe"), "Otter gnp.exe", "a right-to-left override");
  assert.equal(Array.from(cleanName("é".repeat(NAME_MAX + 5))!).length, NAME_MAX);
  assert.equal(
    cleanName("x".repeat(NAME_MAX - 1) + " tail"),
    "x".repeat(NAME_MAX - 1),
    "no trailing space after the cut",
  );
  for (const empty of ["", "   ", "\n\t", 7, null, undefined]) assert.equal(cleanName(empty), null);
});

test("the label names browser and system from the user agent", () => {
  const cases: [string, string][] = [
    ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", "Firefox, Linux"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36", "Chrome, Windows"],
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
  for (const [userAgent, label] of cases) assert.equal(deviceLabel(userAgent), label);
});

test("saved device settings are untrusted: hidden unless exactly true, a bad name replaced", () => {
  assert.deepEqual(parseDevice({ visible: true, name: " Den " }), { visible: true, name: "Den" });
  for (const raw of [null, "x", { visible: "yes", name: 5 }, { visible: 1 }]) {
    const device = parseDevice(raw);
    assert.equal(device.visible, false);
    assert.equal(cleanName(device.name), device.name);
  }
});
