import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { iceServers, parseRelay, relayConfig, withFreshTurn } from "../ice.ts";

const turn = { urls: ["turn:t.example:3478", "turns:t.example:5349?transport=tcp"], username: "u", credential: "c" };

function pairedSetup() {
  const stun = { urls: ["stun:s"] };
  const paired = [stun, { urls: ["turn:t"], username: "100", credential: "old" }];
  const fresh = [stun, { urls: ["turn:t"], username: "220", credential: "new" }];
  const config = relayConfig(paired, "tcp");

  return { stun, paired, fresh, config };
}

describe("ice", () => {
  describe("iceServers", () => {
    const serverSent: RTCIceServer[] = [{ urls: "stun:ours" }, { urls: "turn:ours", username: "x", credential: "y" }];

    test("an own TURN server replaces every server-sent ICE server", () => {
      const servers = iceServers(turn, serverSent);

      assert.deepEqual(servers, [turn]);
    });

    test("keeps the server-sent ICE servers without an own TURN server", () => {
      const servers = iceServers(null, serverSent);

      assert.equal(servers, serverSent);
    });
  });

  describe("relayConfig", () => {
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

    test("auto keeps the servers and allows any candidate", () => {
      const config = relayConfig(servers, "auto");

      assert.deepEqual(config, { iceServers: servers, iceTransportPolicy: "all" });
    });

    test("relay forces TURN", () => {
      const config = relayConfig(servers, "relay");

      assert.deepEqual(config, { iceServers: servers, iceTransportPolicy: "relay" });
    });

    test("tcp moves every turn: URL to TCP once and keeps turns: and stun:", () => {
      const config = relayConfig(servers, "tcp");

      assert.deepEqual(config, {
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
  });

  describe("parseRelay", () => {
    test("reads a true tcp flag as tcp", () => {
      const connection = parseRelay({ t: "relay", tcp: true });

      assert.equal(connection, "tcp");
    });

    test("reads a false tcp flag as relay", () => {
      const connection = parseRelay({ t: "relay", tcp: false });

      assert.equal(connection, "relay");
    });

    test("ignores a message without a boolean tcp", () => {
      const messages = [null, "relay", { t: "relay" }, { t: "relay", tcp: "true" }, { t: "relay", tcp: 1 }];

      const connections = messages.map((message) => parseRelay(message));

      assert.deepEqual(connections, [null, null, null, null, null]);
    });
  });

  describe("withFreshTurn", () => {
    test("swaps in the fresh credentials and keeps the TCP URL", () => {
      const { stun, paired, fresh, config } = pairedSetup();

      const refreshed = withFreshTurn(config, paired, fresh);

      assert.deepEqual(refreshed, {
        iceServers: [stun, { urls: ["turn:t?transport=tcp"], username: "220", credential: "new" }],
        iceTransportPolicy: "relay",
      });
    });

    test("leaves an own TURN server's credentials alone", () => {
      const { paired, fresh } = pairedSetup();
      const own = relayConfig([{ urls: ["turn:mine"], username: "me", credential: "secret" }], "relay");

      const kept = withFreshTurn(own, paired, fresh);

      assert.deepEqual(kept, own);
    });

    test("leaves the config alone when the pairing has no TURN server", () => {
      const { stun, fresh, config } = pairedSetup();

      const kept = withFreshTurn(config, [stun], fresh);

      assert.equal(kept, config);
    });
  });
});
