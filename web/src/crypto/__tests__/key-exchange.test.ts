import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { KeyExchange } from "../key-exchange.ts";

const ristretto = { ristretto255, ristretto255_hasher };
const hex = (text: string) => Uint8Array.from(text.replace(/\s/g, "").match(/../g)!, (byte) => parseInt(byte, 16));
const encoder = new TextEncoder();

async function run(
  passwordA: string,
  passwordB: string,
  channelIdentifierA = encoder.encode("room"),
  channelIdentifierB = channelIdentifierA,
) {
  const creator = await KeyExchange.start(ristretto, "creator", passwordA, channelIdentifierA);
  const joiner = await KeyExchange.start(ristretto, "joiner", passwordB, channelIdentifierB);
  const [tagA, tagB] = await Promise.all([creator.receive(joiner.share), joiner.receive(creator.share)]);
  const [keyA, keyB] = [await creator.verify(tagB!), await joiner.verify(tagA!)];

  return { creator, joiner, keyA, keyB };
}

describe("KeyExchange", () => {
  describe("verify", () => {
    test("both sides confirm and hold the same 64-byte key", async () => {
      const { keyA, keyB } = await run("4TR8N2", "4TR8N2");

      assert.equal(keyA?.byteLength, 64);
      assert.deepEqual(keyA, keyB);
    });

    test("both sides fail confirmation with a wrong password", async () => {
      const { keyA, keyB } = await run("4TR8N2", "4TR8N3");

      assert.equal(keyA, null);
      assert.equal(keyB, null);
    });

    test("both sides fail confirmation in another room", async () => {
      const { keyA, keyB } = await run("4TR8N2", "4TR8N2", encoder.encode("room"), encoder.encode("other"));

      assert.equal(keyA, null);
      assert.equal(keyB, null);
    });

    test("refuses its own tag reflected back", async () => {
      const creator = await KeyExchange.start(ristretto, "creator", "4TR8N2", encoder.encode("room"));
      const selfTag = await creator.receive(creator.share);

      const key = await creator.verify(selfTag!);

      assert.equal(key, null, "own tag reflected back");
    });

    test("refuses a short tag", async () => {
      const { creator } = await run("4TR8N2", "4TR8N2");
      const shortTag = new Uint8Array(63);

      const key = await creator.verify(shortTag);

      assert.equal(key, null, "short tag");
    });
  });

  describe("receive", () => {
    test("refuses the identity", async () => {
      const joiner = await KeyExchange.start(ristretto, "joiner", "4TR8N2", encoder.encode("room"));
      const identity = new Uint8Array(32);

      const tag = await joiner.receive(identity);

      assert.equal(tag, null);
    });

    test("refuses a share that is not 32 bytes", async () => {
      const joiner = await KeyExchange.start(ristretto, "joiner", "4TR8N2", encoder.encode("room"));
      const shortShare = new Uint8Array(31);

      const tag = await joiner.receive(shortShare);

      assert.equal(tag, null);
    });

    test("refuses an invalid point", async () => {
      const joiner = await KeyExchange.start(ristretto, "joiner", "4TR8N2", encoder.encode("room"));
      const invalidPoint = hex("2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c");

      const tag = await joiner.receive(invalidPoint);

      assert.equal(tag, null);
    });

    test("takes one peer share only", async () => {
      const creator = await KeyExchange.start(ristretto, "creator", "4TR8N2", encoder.encode("room"));
      const joiner = await KeyExchange.start(ristretto, "joiner", "4TR8N2", encoder.encode("room"));
      await creator.receive(joiner.share);

      const secondReceive = creator.receive(joiner.share);

      await assert.rejects(secondReceive, /already used/);
    });
  });
});
