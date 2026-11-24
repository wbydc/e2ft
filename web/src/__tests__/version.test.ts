import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readWebVersion = () =>
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;

const readCrateVersion = () =>
  readFileSync(new URL("../../../Cargo.toml", import.meta.url), "utf8").match(/^version = "(.+)"$/m)?.[1];

const readChart = () => readFileSync(new URL("../../../ops/helm/e2ft/Chart.yaml", import.meta.url), "utf8");

const readCompose = () => readFileSync(new URL("../../../ops/docker/docker-compose.yml", import.meta.url), "utf8");

describe("version", () => {
  describe("web/package.json", () => {
    test("is a semantic version", () => {
      const webVersion = readWebVersion();

      assert.match(webVersion, /^\d+\.\d+\.\d+$/);
    });
  });

  describe("Cargo.toml", () => {
    test("matches web/package.json's version", () => {
      const webVersion = readWebVersion();
      const crate = readCrateVersion();

      assert.equal(crate, webVersion, "bump both manifests together");
    });
  });

  describe("Chart.yaml", () => {
    test("has a version equal to Cargo.toml's", () => {
      const crate = readCrateVersion();
      const chart = readChart();

      const version = chart.match(/^version: (.+)$/m)?.[1];

      assert.equal(version, crate, "bump ops/helm/e2ft/Chart.yaml version too");
    });

    test("has an appVersion equal to Cargo.toml's", () => {
      const crate = readCrateVersion();
      const chart = readChart();

      const appVersion = chart.match(/^appVersion: "(.+)"$/m)?.[1];

      assert.equal(appVersion, crate, "bump ops/helm/e2ft/Chart.yaml appVersion too");
    });
  });

  describe("docker-compose.yml", () => {
    test("runs the release image of Cargo.toml's version", () => {
      const crate = readCrateVersion();
      const compose = readCompose();
      const image = "ghcr.io/wbydc/e2ft:";

      const pinned = compose.slice(compose.indexOf(image) + image.length).match(/^[^}\s]+/)?.[0];

      assert.equal(pinned, crate, "bump the image in ops/docker/docker-compose.yml too");
    });
  });
});
