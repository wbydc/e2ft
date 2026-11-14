import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("web/package.json and Cargo.toml carry the same version", () => {
  const webVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  const crate = readFileSync(new URL("../../../Cargo.toml", import.meta.url), "utf8").match(/^version = "(.+)"$/m)?.[1];
  assert.match(webVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(crate, webVersion, "bump both manifests together");
});
