import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { laneCap, laneConfig } from "../lanes.ts";

const stun = { urls: "stun:turn.example:3478" };
const turn = (urls: string[]) => ({ urls, username: "1600", credential: "c" });
const both = turn(["turn:turn.example:3478?transport=udp", "turn:turn.example:3478?transport=tcp"]);
const directPlan = { config: { iceServers: [stun, both], iceTransportPolicy: "all" as const }, relayed: false };
const relayedPlan = { config: { iceServers: [stun, both], iceTransportPolicy: "relay" as const }, relayed: true };
const tcpPlan = { config: { iceServers: [turn(["turn:turn.example:3478?transport=tcp"])] }, relayed: true };

describe("lanes", () => {
  describe("laneConfig", () => {
    describe("after a direct connection 0", () => {
      test("drops every TURN server", () => {
        const config = laneConfig(directPlan);

        assert.deepEqual(config.iceServers, [{ urls: ["stun:turn.example:3478"] }]);
      });
    });

    describe("over a relayed connection 0", () => {
      test("keeps the connection 0 config", () => {
        const config = laneConfig(relayedPlan);

        assert.equal(config, relayedPlan.config);
      });
    });
  });

  describe("laneCap", () => {
    describe("after a direct connection 0", () => {
      test("gives 8 connections one way", () => {
        const cap = laneCap(directPlan, false);

        assert.equal(cap, 8);
      });

      test("gives 8 connections both ways", () => {
        const cap = laneCap(directPlan, true);

        assert.equal(cap, 8);
      });
    });

    describe("over a relayed connection 0 with two TURN URLs", () => {
      test("gives 3 connections one way", () => {
        const cap = laneCap(relayedPlan, false);

        assert.equal(cap, 3, "2 URLs x 2 sides = 4 allocations per connection, 3 connections");
      });

      test("gives 2 connections both ways", () => {
        const cap = laneCap(relayedPlan, true);

        assert.equal(cap, 2, "connection 0 plus one extra each way");
      });
    });

    describe("over a relayed connection 0 with one TURN URL", () => {
      test("gives 6 connections one way", () => {
        const cap = laneCap(tcpPlan, false);

        assert.equal(cap, 6, "1 URL x 2 sides = 2 allocations per connection, 6 connections");
      });

      test("gives 3 connections both ways", () => {
        const cap = laneCap(tcpPlan, true);

        assert.equal(cap, 3, "connection 0 plus two extra each way");
      });
    });
  });
});
