import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Signal } from "../signal.ts";
import type { SignalHandlers } from "../signal.ts";
import { FakeSocket } from "./fake-socket.ts";

// The page loads the CPace group math as the lazy chunk /ristretto.js; here it is the source module.
const ristretto = new URL("../../crypto/ristretto.ts", import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) => next(specifier === "/ristretto.js" ? ristretto : specifier, context),
});
Object.assign(globalThis, { WebSocket: FakeSocket, location: { protocol: "http:", host: "test" } });

const pairing = (gen: number) => ({ t: "joined", iceServers: [], gen, keepAlive: 0 });
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
let active: Signal | undefined;

function joiner() {
  const failures: unknown[] = [];
  const handlers = new Proxy({} as SignalHandlers, {
    get: (_, name) => (name === "fail" ? (err: unknown) => failures.push(err) : () => {}),
  });
  FakeSocket.opened = [];
  const signal = new Signal("joiner", "ABCDEFGH", "SECRET", handlers);
  active = signal;

  return { signal, failures, socket: () => FakeSocket.opened.at(-1)! };
}

async function reconnectedJoiner(gen: number) {
  const joined = joiner();
  joined.socket().serverSays(pairing(gen));
  await tick();
  joined.socket().onclose?.();
  await tick();

  return joined;
}

afterEach(() => {
  active?.leave();
  active = undefined;
});

describe("Signal", () => {
  describe("reconnect", () => {
    test("a reconnect that gets a higher pairing number carries on", async () => {
      const { failures, socket } = await reconnectedJoiner(1);

      socket().serverSays(pairing(2));
      await tick();

      assert.equal(FakeSocket.opened.length, 2);
      assert.deepEqual(failures, []);
    });

    test("an earlier pairing number after a reconnect ends the room", async () => {
      const { failures, socket } = await reconnectedJoiner(2);

      socket().serverSays(pairing(1));
      await tick();

      assert.equal(failures.length, 1, "gen 1 after 2");
      assert.match(String(failures[0]), /earlier pairing/);
    });

    test("the same pairing number after a reconnect ends the room", async () => {
      const { failures, socket } = await reconnectedJoiner(2);

      socket().serverSays(pairing(2));
      await tick();

      assert.equal(failures.length, 1, "gen 2 after 2");
      assert.match(String(failures[0]), /earlier pairing/);
    });
  });
});
