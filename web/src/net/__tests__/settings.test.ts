import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, parseSettings, parseTurn } from "../settings.ts";

const turn = { urls: ["turn:t.example:3478", "turns:t.example:5349?transport=tcp"], username: "u", credential: "c" };

describe("settings", () => {
  describe("parseSettings", () => {
    test("keeps valid settings through a JSON round trip", () => {
      const settings = { turn, keepAlive: 900, hideQr: true, shareTurn: true, alwaysTurn: true } as const;

      const parsed = parseSettings(JSON.parse(JSON.stringify(settings)));

      assert.deepEqual(parsed, settings);
    });

    test("falls back to the defaults for invalid saved data", () => {
      const raws = [null, 42, "x", [], {}, { keepAlive: 3600 }, { keepAlive: "300" }];

      const settings = raws.map((raw) => parseSettings(raw));

      assert.deepEqual(
        settings,
        raws.map(() => DEFAULTS),
      );
    });

    test("keeps zero as the off keep-alive", () => {
      const keepAlive = parseSettings({ keepAlive: 0 }).keepAlive;

      assert.equal(keepAlive, 0, "Off is a real choice, not missing");
    });

    test("drops a TURN entry that is not a usable server", () => {
      const entries = [
        { ...turn, urls: ["stun:t.example"] },
        { ...turn, urls: ["https://t.example"] },
        { ...turn, urls: [] },
        { urls: turn.urls, username: "u" },
        { ...turn, username: "" },
        { ...turn, credential: "" },
        { ...turn, urls: ["turn:a turn:b"] },
      ];

      const turns = entries.map((turnEntry) => parseSettings({ turn: turnEntry, keepAlive: 60 }).turn);

      assert.deepEqual(
        turns,
        entries.map(() => null),
      );
    });

    describe("shareTurn", () => {
      test("is off by default", () => {
        const shareTurn = parseSettings({ turn }).shareTurn;

        assert.equal(shareTurn, false);
      });

      test("is ignored without a TURN server", () => {
        const shareTurn = parseSettings({ turn: null, shareTurn: true }).shareTurn;

        assert.equal(shareTurn, false);
      });

      test("ignores a saved value that is not true", () => {
        const shareTurn = parseSettings({ turn, shareTurn: "yes" }).shareTurn;

        assert.equal(shareTurn, false);
      });
    });

    describe("alwaysTurn", () => {
      test("is off by default", () => {
        const settings = parseSettings({});

        assert.equal(DEFAULTS.alwaysTurn, false);
        assert.equal(settings.alwaysTurn, false);
      });

      test("ignores a saved value that is not true", () => {
        const values = ["true", 1, {}, null];

        const alwaysTurn = values.map((value) => parseSettings({ alwaysTurn: value }).alwaysTurn);

        assert.deepEqual(alwaysTurn, [false, false, false, false]);
      });

      test("turns on only for a saved true", () => {
        const alwaysTurn = parseSettings({ alwaysTurn: true }).alwaysTurn;

        assert.equal(alwaysTurn, true);
      });
    });
  });

  describe("parseTurn", () => {
    test("keeps only the TURN fields of a valid message", () => {
      const parsed = parseTurn({ t: "turn", ...turn, extra: 1 });

      assert.deepEqual(parsed, turn);
    });

    test("rejects a message that is not a usable TURN server", () => {
      const messages = [
        null,
        "turn",
        { t: "turn" },
        { t: "turn", ...turn, urls: ["stun:x"] },
        { t: "turn", ...turn, urls: "turn:x" },
        { t: "turn", urls: turn.urls, username: "u" },
        { t: "turn", ...turn, credential: 7 },
      ];

      const parsed = messages.map((message) => parseTurn(message));

      assert.deepEqual(parsed, [null, null, null, null, null, null, null]);
    });
  });
});
