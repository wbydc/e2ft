import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("web/package.json and Cargo.toml carry the same version", () => {
  const webVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  const crate = readFileSync(new URL("../../../Cargo.toml", import.meta.url), "utf8").match(/^version = "(.+)"$/m)?.[1];
  assert.match(webVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(crate, webVersion, "bump both manifests together");
});

test("the Helm chart's version and appVersion equal Cargo.toml's", () => {
  const crate = readFileSync(new URL("../../../Cargo.toml", import.meta.url), "utf8").match(/^version = "(.+)"$/m)?.[1];
  const chart = readFileSync(new URL("../../../ops/helm/e2ft/Chart.yaml", import.meta.url), "utf8");
  assert.equal(chart.match(/^version: (.+)$/m)?.[1], crate, "bump ops/helm/e2ft/Chart.yaml version too");
  assert.equal(chart.match(/^appVersion: "(.+)"$/m)?.[1], crate, "bump ops/helm/e2ft/Chart.yaml appVersion too");
});
