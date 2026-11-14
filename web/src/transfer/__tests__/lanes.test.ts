import { test } from "node:test";
import assert from "node:assert/strict";
import { laneCap, laneConfig } from "../lanes.ts";

const stun = { urls: "stun:turn.example:3478" };
const turn = (urls: string[]) => ({ urls, username: "1600", credential: "c" });
const both = turn(["turn:turn.example:3478?transport=udp", "turn:turn.example:3478?transport=tcp"]);

test("after a direct connection 0, lanes carry no TURN server and up to 8 go each way", () => {
  const plan = { config: { iceServers: [stun, both], iceTransportPolicy: "all" as const }, relayed: false };
  assert.deepEqual(laneConfig(plan).iceServers, [{ urls: ["stun:turn.example:3478"] }]);
  assert.equal(laneCap(plan, false), 8);
  assert.equal(laneCap(plan, true), 8);
});

test("a relayed connection 0 keeps TURN, and the quota of 12 decides the lanes", () => {
  const relayedPlan = { config: { iceServers: [stun, both], iceTransportPolicy: "relay" as const }, relayed: true };
  assert.equal(laneConfig(relayedPlan), relayedPlan.config);
  assert.equal(laneCap(relayedPlan, false), 3, "2 URLs x 2 sides = 4 allocations per connection, 3 connections");
  assert.equal(laneCap(relayedPlan, true), 2, "connection 0 plus one extra each way");
  const tcpPlan = { config: { iceServers: [turn(["turn:turn.example:3478?transport=tcp"])] }, relayed: true };
  assert.equal(laneCap(tcpPlan, false), 6, "1 URL x 2 sides = 2 allocations per connection, 6 connections");
  assert.equal(laneCap(tcpPlan, true), 3, "connection 0 plus two extra each way");
});
