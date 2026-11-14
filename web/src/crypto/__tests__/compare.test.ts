import { test } from "node:test";
import assert from "node:assert/strict";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { ACCESS_LEN } from "../invite.ts";
import { KeyExchange, commitTo, opensCommitment } from "../key-exchange.ts";
import { compareCode, roomCrypto } from "../keys.ts";

const ristretto = { ristretto255, ristretto255_hasher };
const ACCESS_KEY = "7K2M9QXT7K2M9QXT".slice(0, ACCESS_LEN);
const channel = new TextEncoder().encode("room");

/** One discovered exchange between `creator` and `joiner`, each side's session key turned into its code. */
async function codes(creator: KeyExchange, joiner: KeyExchange) {
  const [tagA, tagB] = await Promise.all([creator.receive(joiner.share), joiner.receive(creator.share)]);
  const [keyA, keyB] = [await creator.verify(tagB!), await joiner.verify(tagA!)];

  return Promise.all([keyA!, keyB!].map(async (isk) => compareCode(await roomCrypto(ACCESS_KEY, isk))));
}

const start = (role: "creator" | "joiner") => KeyExchange.start(ristretto, role, "discovered", channel);

test("an honest discovered exchange shows the same 6 digits on both screens", async () => {
  const [codeA, codeB] = await codes(await start("creator"), await start("joiner"));
  assert.match(codeA, /^\d{6}$/);
  assert.equal(codeA, codeB);
});

test("a relay running its own exchange with each side leaves them different codes", async () => {
  // The relay plays joiner to the creator and creator to the joiner, so each side holds another session key.
  const [withCreator] = await codes(await start("creator"), await start("joiner"));
  const [, withJoiner] = await codes(await start("creator"), await start("joiner"));
  assert.notEqual(withCreator, withJoiner);
});

test("only the committed share opens the commitment", async () => {
  const creator = await start("creator");
  const other = await start("creator");
  const commitment = await commitTo(creator.share);
  assert.equal(commitment.byteLength, 64);
  assert.equal(await opensCommitment(commitment, creator.share), true);
  assert.equal(await opensCommitment(commitment, other.share), false, "a share chosen after the commitment");
  assert.equal(await opensCommitment(commitment.subarray(0, 32), creator.share), false, "a short commitment");
});
