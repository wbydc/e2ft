import { describe, test } from "node:test";
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

  return Promise.all([keyA!, keyB!].map(async (sessionKey) => compareCode(await roomCrypto(ACCESS_KEY, sessionKey))));
}

const start = (role: "creator" | "joiner") => KeyExchange.start(ristretto, role, "discovered", channel);

describe("compare", () => {
  describe("compareCode", () => {
    test("shows the same six digits on both screens after an honest exchange", async () => {
      const creator = await start("creator");
      const joiner = await start("joiner");

      const [codeA, codeB] = await codes(creator, joiner);

      assert.match(codeA, /^\d{6}$/);
      assert.equal(codeA, codeB);
    });

    test("shows different codes when a relay runs its own exchange with each side", async () => {
      // The relay plays joiner to the creator and creator to the joiner, so each side holds another session key.
      const [withCreator] = await codes(await start("creator"), await start("joiner"));
      const [, withJoiner] = await codes(await start("creator"), await start("joiner"));

      assert.notEqual(withCreator, withJoiner);
    });
  });

  describe("commitTo", () => {
    test("commits to a share in 64 bytes", async () => {
      const creator = await start("creator");

      const commitment = await commitTo(creator.share);

      assert.equal(commitment.byteLength, 64);
    });
  });

  describe("opensCommitment", () => {
    test("accepts the committed share", async () => {
      const creator = await start("creator");
      const commitment = await commitTo(creator.share);

      const opens = await opensCommitment(commitment, creator.share);

      assert.equal(opens, true);
    });

    test("rejects a share chosen after the commitment", async () => {
      const creator = await start("creator");
      const other = await start("creator");
      const commitment = await commitTo(creator.share);

      const opens = await opensCommitment(commitment, other.share);

      assert.equal(opens, false, "a share chosen after the commitment");
    });

    test("rejects a short commitment", async () => {
      const creator = await start("creator");
      const commitment = await commitTo(creator.share);

      const opens = await opensCommitment(commitment.subarray(0, 32), creator.share);

      assert.equal(opens, false, "a short commitment");
    });
  });
});
