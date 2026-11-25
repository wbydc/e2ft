import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { Peer } from "../peer.ts";
import { FakeConnection } from "./fake-connection.ts";

const noIdentity = () => new DOMException("Fingerprint provided but no identity available.", "OperationError");

/** Starts a creator Peer and waits until its offer went out or it failed. */
async function offer(failures: Error[]): Promise<{ sent: unknown[]; failed: unknown[] }> {
  FakeConnection.failures = failures;
  const sent: unknown[] = [];
  const failed: unknown[] = [];
  const peer = new Peer("creator", {}, (message) => sent.push(message), {
    open: () => {},
    closed: () => {},
    fail: (err) => failed.push(err),
  });
  // Each retry waits on a timer that is set only after the previous attempt's promise settles.
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(1000);
  }

  peer.close();

  return { sent, failed };
}

describe("Peer", () => {
  describe("offer", () => {
    beforeEach(() => {
      FakeConnection.calls = 0;
      (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakeConnection;
      mock.timers.enable({ apis: ["setTimeout"] });
    });

    afterEach(() => {
      mock.timers.reset();
      delete (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    });

    test("an OperationError on the first offer is retried, and the offer goes out", async () => {
      const { sent, failed } = await offer([noIdentity(), noIdentity()]);

      assert.deepEqual(sent, [{ t: "sdp", d: { type: "offer", sdp: "v=0" } }]);
      assert.deepEqual(failed, []);
      assert.equal(FakeConnection.calls, 3);
    });

    test("fails after three OperationErrors", async () => {
      const { sent, failed } = await offer([noIdentity(), noIdentity(), noIdentity()]);

      assert.deepEqual(sent, []);
      assert.equal(failed.length, 1);
      assert.equal(FakeConnection.calls, 3);
    });

    test("any other error fails at once", async () => {
      const { sent, failed } = await offer([new DOMException("closed", "InvalidStateError")]);

      assert.deepEqual(sent, []);
      assert.equal(failed.length, 1);
      assert.equal(FakeConnection.calls, 1);
    });
  });
});
