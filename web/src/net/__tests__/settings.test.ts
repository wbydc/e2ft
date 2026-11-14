import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, parseSettings, parseTurn } from "../settings.ts";

const turn = { urls: ["turn:t.example:3478", "turns:t.example:5349?transport=tcp"], username: "u", credential: "c" };

test("valid settings round-trip through JSON", () => {
  const settings = { turn, keepAlive: 900, hideQr: true, shareTurn: true, alwaysTurn: true } as const;
  assert.deepEqual(parseSettings(JSON.parse(JSON.stringify(settings))), settings);
});

test("bad saved data falls back to the defaults", () => {
  for (const raw of [null, 42, "x", [], {}, { keepAlive: 3600 }, { keepAlive: "300" }])
    assert.deepEqual(parseSettings(raw), DEFAULTS);
  assert.equal(parseSettings({ keepAlive: 0 }).keepAlive, 0, "Off is a real choice, not missing");
});

test("a TURN entry with a non-turn URL, no URLs, or an empty or missing username or credential is dropped", () => {
  for (const turnEntry of [
    { ...turn, urls: ["stun:t.example"] },
    { ...turn, urls: ["https://t.example"] },
    { ...turn, urls: [] },
    { urls: turn.urls, username: "u" },
    { ...turn, username: "" },
    { ...turn, credential: "" },
    { ...turn, urls: ["turn:a turn:b"] },
  ])
    assert.equal(parseSettings({ turn: turnEntry, keepAlive: 60 }).turn, null);
});

test("sharing is off by default and ignored without a TURN server", () => {
  assert.equal(parseSettings({ turn }).shareTurn, false);
  assert.equal(parseSettings({ turn: null, shareTurn: true }).shareTurn, false);
  assert.equal(parseSettings({ turn, shareTurn: "yes" }).shareTurn, false);
});

test("Always use TURN is off by default and only a saved true turns it on", () => {
  assert.equal(DEFAULTS.alwaysTurn, false);
  assert.equal(parseSettings({}).alwaysTurn, false);
  for (const value of ["true", 1, {}, null]) assert.equal(parseSettings({ alwaysTurn: value }).alwaysTurn, false);
  assert.equal(parseSettings({ alwaysTurn: true }).alwaysTurn, true);
});

test("a peer's turn message is accepted only when valid, and only the TURN fields are kept", () => {
  assert.deepEqual(parseTurn({ t: "turn", ...turn, extra: 1 }), turn);
  for (const message of [
    null,
    "turn",
    { t: "turn" },
    { t: "turn", ...turn, urls: ["stun:x"] },
    { t: "turn", ...turn, urls: "turn:x" },
    { t: "turn", urls: turn.urls, username: "u" },
    { t: "turn", ...turn, credential: 7 },
  ])
    assert.equal(parseTurn(message), null);
});
