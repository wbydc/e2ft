import { test } from "node:test";
import assert from "node:assert/strict";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { KeyExchange } from "../key-exchange.ts";

const ristretto = { ristretto255, ristretto255_hasher };
const hex = (s: string) => Uint8Array.from(s.replace(/\s/g, "").match(/../g)!, (b) => parseInt(b, 16));
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

  return { a: creator, b: joiner, ka: await creator.verify(tagB!), kb: await joiner.verify(tagA!) };
}

test("same password and room: both sides confirm and hold the same 64-byte key", async () => {
  const { ka: keyA, kb: keyB } = await run("4TR8N2", "4TR8N2");
  assert.equal(keyA?.byteLength, 64);
  assert.deepEqual(keyA, keyB);
});

test("a wrong password or another room fails confirmation on both sides", async () => {
  for (const result of [
    await run("4TR8N2", "4TR8N3"),
    await run("4TR8N2", "4TR8N2", encoder.encode("room"), encoder.encode("other")),
  ]) {
    assert.equal(result.ka, null);
    assert.equal(result.kb, null);
  }
});

test("reflected shares and tags, the identity and junk are refused", async () => {
  const creator = await KeyExchange.start(ristretto, "creator", "4TR8N2", encoder.encode("room"));
  const self = await creator.receive(creator.share);
  assert.equal(await creator.verify(self!), null, "own tag reflected back");
  for (const invalidShare of [
    new Uint8Array(32),
    new Uint8Array(31),
    hex("2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c"),
  ]) {
    const exchange = await KeyExchange.start(ristretto, "joiner", "4TR8N2", encoder.encode("room"));
    assert.equal(await exchange.receive(invalidShare), null);
  }
  const { a: ok } = await run("4TR8N2", "4TR8N2");
  assert.equal(await ok.verify(new Uint8Array(63)), null, "short tag");
});

test("an exchange takes one peer share only", async () => {
  const creator = await KeyExchange.start(ristretto, "creator", "4TR8N2", encoder.encode("room"));
  const joiner = await KeyExchange.start(ristretto, "joiner", "4TR8N2", encoder.encode("room"));
  await creator.receive(joiner.share);
  await assert.rejects(creator.receive(joiner.share), /already used/);
});
