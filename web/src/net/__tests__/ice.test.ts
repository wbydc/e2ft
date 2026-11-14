import { test } from "node:test";
import assert from "node:assert/strict";
import { iceServers, parseRelay, relayConfig, withFreshTurn } from "../ice.ts";

const turn = { urls: ["turn:t.example:3478", "turns:t.example:5349?transport=tcp"], username: "u", credential: "c" };

test("an own TURN server replaces every server-sent ICE server", () => {
  const ours = [{ urls: "stun:ours" }, { urls: "turn:ours", username: "x", credential: "y" }];
  assert.deepEqual(iceServers(turn, ours), [turn]);
  assert.equal(iceServers(null, ours), ours);
});

test("relayConfig: auto keeps the servers, relay forces TURN, tcp moves turn: URLs to TCP once and keeps turns: and stun:", () => {
  const servers: RTCIceServer[] = [
    { urls: "stun:s.example:3478" },
    {
      urls: [
        "turn:t.example:3478?transport=udp",
        "turn:t.example:3478?transport=tcp",
        "turn:t.example:3479",
        "turns:t.example:5349",
      ],
      username: "u",
      credential: "c",
    },
  ];
  assert.deepEqual(relayConfig(servers, "auto"), { iceServers: servers, iceTransportPolicy: "all" });
  assert.deepEqual(relayConfig(servers, "relay"), { iceServers: servers, iceTransportPolicy: "relay" });
  assert.deepEqual(relayConfig(servers, "tcp"), {
    iceServers: [
      { urls: ["stun:s.example:3478"] },
      {
        urls: ["turn:t.example:3478?transport=tcp", "turn:t.example:3479?transport=tcp", "turns:t.example:5349"],
        username: "u",
        credential: "c",
      },
    ],
    iceTransportPolicy: "relay",
  });
});

test("a peer's relay message counts only with a boolean tcp", () => {
  assert.equal(parseRelay({ t: "relay", tcp: true }), "tcp");
  assert.equal(parseRelay({ t: "relay", tcp: false }), "relay");
  for (const message of [null, "relay", { t: "relay" }, { t: "relay", tcp: "true" }, { t: "relay", tcp: 1 }])
    assert.equal(parseRelay(message), null);
});

test("withFreshTurn swaps the pairing's TURN credentials, keeps TCP URLs and leaves other TURN servers alone", () => {
  const stun = { urls: ["stun:s"] };
  const paired = [stun, { urls: ["turn:t"], username: "100", credential: "old" }];
  const fresh = [stun, { urls: ["turn:t"], username: "220", credential: "new" }];
  const config = relayConfig(paired, "tcp");

  assert.deepEqual(withFreshTurn(config, paired, fresh), {
    iceServers: [stun, { urls: ["turn:t?transport=tcp"], username: "220", credential: "new" }],
    iceTransportPolicy: "relay",
  });

  const own = relayConfig([{ urls: ["turn:mine"], username: "me", credential: "secret" }], "relay");
  assert.deepEqual(withFreshTurn(own, paired, fresh), own);
  assert.equal(withFreshTurn(config, [stun], fresh), config);
});
