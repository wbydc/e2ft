import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS } from "../../src/config.ts";
import { resolveConfig } from "../config.mjs";

test("no env gives today's values", () => {
  assert.deepEqual(resolveConfig({}), DEFAULTS);
  assert.deepEqual(resolveConfig({ CHUNK_SIZE: "", OTHER: "1" }), DEFAULTS);
});

test("overrides are parsed, lists included", () => {
  const config = resolveConfig({ CHUNK_SIZE: " 131072 ", GAIN: "1.5", KEEP_ALIVES: "0, 120,600", KEEP_ALIVE: "120" });

  assert.equal(config.CHUNK_SIZE, 131072);
  assert.equal(config.GAIN, 1.5);
  assert.deepEqual(config.KEEP_ALIVES, [0, 120, 600]);
  assert.equal(config.KEEP_ALIVE, 120);
  assert.equal(config.WINDOW, DEFAULTS.WINDOW);
});

const rejected = {
  "not a number": [{ CHUNK_SIZE: "abc" }, /CHUNK_SIZE: abc, expected an integer from 1024 to 262120$/],
  "a fraction": [{ WINDOW: "16.5" }, /WINDOW: 16.5,/],
  "above the data channel limit": [{ CHUNK_SIZE: "1048576" }, /CHUNK_SIZE: 1048576,/],
  "below the CPace floor": [{ SECRET_LEN: "4" }, /SECRET_LEN: 4, expected an integer from 6 to 16$/],
  "a gain of 1": [{ GAIN: "1" }, /GAIN: 1, expected a number above 1/],
  "low buffer above high": [{ BUFFER_LOW: "9000000" }, /BUFFER_LOW: 9000000, expected below BUFFER_HIGH \(8388608\)$/],
  "a window over the memory cap": [{ CHUNK_SIZE: "262120", WINDOW: "2048" }, /WINDOW: 2048,/],
  "acks rarer than the window": [{ WINDOW: "16", ACK_EVERY: "32" }, /ACK_EVERY: 32, expected at most WINDOW \(16\)$/],
  "an unsorted keep-alive list": [{ KEEP_ALIVES: "0,300,60" }, /KEEP_ALIVES: 0,300,60, expected at most 8 ascending/],
  "more keep-alives than the invite holds": [{ KEEP_ALIVES: "0,1,2,3,4,5,6,300,7200" }, /KEEP_ALIVES:/],
  "a bad keep-alive entry": [{ KEEP_ALIVES: "0,x" }, /KEEP_ALIVES: x, expected comma-separated integers/],
  "a default keep-alive outside the list": [
    { KEEP_ALIVES: "0,120,600" },
    /KEEP_ALIVE: 300, expected one of KEEP_ALIVES \(0,120,600\)$/,
  ],
};

for (const [name, [env, message]] of Object.entries(rejected)) {
  test(`rejects ${name}`, () => assert.throws(() => resolveConfig(env), message));
}
