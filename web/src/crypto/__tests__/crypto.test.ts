import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Invite, inviteFragment, normalizeKey, parseAccessKey, parseFragment } from "../invite.ts";
import { fileKey, roomCrypto } from "../keys.ts";
import { openChunk, sealChunk, Sealer } from "../sealer.ts";
import type { InviteHints } from "../invite.ts";
import type { Bytes } from "../keys.ts";

const { accessKey, secret } = Invite.create({
  keepAlive: 300,
  connection: "auto",
  shareTurn: false,
});
const randomSessionKey = () => crypto.getRandomValues(new Uint8Array(64));
const sharedSessionKey = randomSessionKey();
// roomCrypto zeroes what it is given, so each call gets its own copy of the shared session key.
const makeRoomCrypto = (sessionKey: Bytes = sharedSessionKey) => roomCrypto(accessKey, sessionKey.slice());

/** A creator sender and joiner receiver on one room signal, plus the creator's first sealed message. */
async function sealedFirstMessage(label = "sig") {
  const room = await makeRoomCrypto();
  const sender = new Sealer(room.signal, label, "creator");
  const receiver = new Sealer(room.signal, label, "joiner");

  return { room, receiver, sealedMessage: await sender.seal("first") };
}

/** One transfer's key, another transfer's key in the same room, and a chunk sealed at index 7. */
async function sealedChunkPair() {
  const room = await makeRoomCrypto();
  const transferKey = await fileKey(room, "t1");
  const otherTransferKey = await fileKey(room, "t2");
  const chunkData = crypto.getRandomValues(new Uint8Array(1000));

  return { transferKey, otherTransferKey, chunkData, sealedChunk: await sealChunk(transferKey, 7, chunkData) };
}

const origin = "https://share.example";
const DEFAULTS: InviteHints = { keepAlive: 300, connection: "auto", shareTurn: false };
const ALL_HINTS: InviteHints[] = [];
for (const keepAlive of [300, 0, 60, 900, 1800] as const)
  for (const connection of ["auto", "relay", "tcp"] as const)
    for (const shareTurn of [false, true]) ALL_HINTS.push({ keepAlive, connection, shareTurn });

describe("invite", () => {
  describe("Invite", () => {
    describe("create", () => {
      test("makes an 8-character Crockford access key", () => {
        assert.match(accessKey, /^[0-9A-HJKMNP-TV-Z]{8}$/);
      });

      test("makes a 6-character Crockford secret", () => {
        assert.match(secret, /^[0-9A-HJKMNP-TV-Z]{6}$/);
      });
    });

    describe("parse", () => {
      test("reads every hint combination from a link", () => {
        const links = ALL_HINTS.map((hints) => `${origin}/r/${accessKey}#${inviteFragment(secret, hints)}`);

        const parsed = links.map((link) => Invite.parse(link, origin));

        assert.deepEqual(
          parsed,
          ALL_HINTS.map((hints) => new Invite(accessKey, secret, hints)),
        );
      });

      test("reads a link built by link()", () => {
        const links = ALL_HINTS.map((hints) => new Invite(accessKey, secret, hints).link(origin));

        const parsed = links.map((link) => Invite.parse(link, origin));

        assert.deepEqual(
          parsed,
          ALL_HINTS.map((hints) => new Invite(accessKey, secret, hints)),
          "link()",
        );
      });

      test("reads this origin's invite link", () => {
        const parsed = Invite.parse(`${origin}/r/${accessKey}#${secret}`, origin);

        assert.deepEqual(parsed, new Invite(accessKey, secret, DEFAULTS));
      });

      test("reads an invite link in any case", () => {
        const parsed = Invite.parse(`${origin}/r/${accessKey.toLowerCase()}#${secret.toLowerCase()}`, origin);

        assert.deepEqual(parsed, new Invite(accessKey, secret, DEFAULTS));
      });

      test("refuses another origin", () => {
        const parsed = Invite.parse(`https://evil.example/r/${accessKey}#${secret}`, origin);

        assert.equal(parsed, null);
      });

      test("refuses an http link", () => {
        const parsed = Invite.parse(`http://share.example/r/${accessKey}#${secret}`, origin);

        assert.equal(parsed, null);
      });

      test("refuses a secret that is too short", () => {
        const parsed = Invite.parse(`${origin}/r/${accessKey}#${secret.slice(1)}`, origin);

        assert.equal(parsed, null);
      });

      test("refuses a link without a fragment", () => {
        const parsed = Invite.parse(`${origin}/r/${accessKey}`, origin);

        assert.equal(parsed, null);
      });

      test("refuses another path", () => {
        const parsed = Invite.parse(`${origin}/x/${accessKey}#${secret}`, origin);

        assert.equal(parsed, null);
      });

      test("refuses a link with a query", () => {
        const parsed = Invite.parse(`${origin}/r/${accessKey}?a=1#${secret}`, origin);

        assert.equal(parsed, null);
      });

      test("refuses an access key of the wrong length", () => {
        const parsed = Invite.parse(`${origin}/r/${accessKey}0#${secret}`, origin);

        assert.equal(parsed, null);
      });

      test("refuses text that is not a link", () => {
        const parsed = Invite.parse("hello world", origin);

        assert.equal(parsed, null);
      });
    });

    describe("fromTyped", () => {
      test("reads a lower-case access key and fragment typed into the join form", () => {
        const typed = ALL_HINTS.map(
          (hints) => [accessKey.toLowerCase(), inviteFragment(secret, hints).toLowerCase()] as const,
        );

        const invites = typed.map(([accessText, fragment]) => Invite.fromTyped(accessText, fragment));

        assert.deepEqual(
          invites,
          ALL_HINTS.map((hints) => new Invite(accessKey, secret, hints)),
          "typed",
        );
      });
    });
  });

  describe("normalizeKey", () => {
    test("uppercases and drops dashes and spaces", () => {
      const normalized = normalizeKey("7k2m-xq9p");

      assert.equal(normalized, "7K2MXQ9P");
    });

    test("reads I and L as 1 and O as 0", () => {
      const normalized = normalizeKey("il o");

      assert.equal(normalized, "110");
    });

    test("refuses U", () => {
      const normalized = normalizeKey("ABCU");

      assert.equal(normalized, null);
    });

    test("refuses a character outside the alphabet", () => {
      const normalized = normalizeKey("AB_C");

      assert.equal(normalized, null);
    });
  });

  describe("parseAccessKey", () => {
    test("trims and normalizes a typed access key", () => {
      const parsed = parseAccessKey(" 7k2m xq9p ");

      assert.equal(parsed, "7K2MXQ9P");
    });

    test("refuses a key of the wrong length", () => {
      const parsed = parseAccessKey("7K2MXQ9");

      assert.equal(parsed, null);
    });
  });

  describe("inviteFragment", () => {
    test("encodes every hint combination in two config chars", () => {
      const fragments = ALL_HINTS.map((hints) => inviteFragment(secret, hints));

      assert.equal(ALL_HINTS.length, 30);
      assert.ok(fragments.every((fragment) => fragment.length === 8));
      assert.ok(fragments.every((fragment) => fragment.slice(2) === secret));
      assert.equal(new Set(fragments.map((fragment) => fragment.slice(0, 2))).size, 30);
    });

    test("a default room's config is 00", () => {
      const config = inviteFragment(secret, DEFAULTS).slice(0, 2);

      assert.equal(config, "00");
    });

    test("900 s keep-alive, tcp and share turn encode as 1K", () => {
      // 900 s is keep-alive index 3, tcp is connection 2 (bits 3-4), share is bit 5: 3 + 16 + 32 = 51.
      const config = inviteFragment(secret, { keepAlive: 900, connection: "tcp", shareTurn: true }).slice(0, 2);

      assert.equal(config, "1K");
    });

    test("carries only the three hints, so no TURN credentials can be encoded", () => {
      const withTurn = {
        keepAlive: 900,
        connection: "relay",
        shareTurn: true,
        turn: { urls: ["turn:x"], username: "u", credential: "c" },
      } as InviteHints;

      const fragment = inviteFragment(secret, withTurn);

      assert.equal(fragment.length, 8);
      assert.equal(fragment.slice(2), secret);
    });
  });

  describe("parseFragment", () => {
    test("reads a lower-case fragment", () => {
      const fragments = ALL_HINTS.map((hints) => inviteFragment(secret, hints).toLowerCase());

      const parsed = fragments.map((fragment) => parseFragment(fragment));

      assert.deepEqual(
        parsed,
        ALL_HINTS.map((hints) => ({ secret, hints })),
        "typed in lower case",
      );
    });

    test("ignores spare config bits", () => {
      // Bits 6-9 set on top of a default room ("Y" is 11110 in the high char, bit 5 clear): still a default room.
      const parsed = parseFragment("Y0" + secret);

      assert.deepEqual(parsed, { secret, hints: DEFAULTS });
    });

    test("treats keep-alive index 5 as unknown hints", () => {
      const parsed = parseFragment("05" + secret);

      assert.deepEqual(parsed, { secret, hints: null }, "05");
    });

    test("treats keep-alive index 7 as unknown hints", () => {
      const parsed = parseFragment("07" + secret);

      assert.deepEqual(parsed, { secret, hints: null }, "07");
    });

    test("treats connection index 3 as unknown hints", () => {
      const parsed = parseFragment("0R" + secret);

      assert.deepEqual(parsed, { secret, hints: null }, "0R");
    });

    test("reads a bare six-character secret as a default room", () => {
      const parsed = parseFragment(secret);

      assert.deepEqual(parsed, { secret, hints: DEFAULTS });
    });

    test("treats one extra character as unknown hints", () => {
      const parsed = parseFragment("0" + secret);

      assert.deepEqual(parsed, { secret, hints: null });
    });

    test("treats three extra characters as unknown hints", () => {
      const parsed = parseFragment("000" + secret);

      assert.deepEqual(parsed, { secret, hints: null });
    });

    test("refuses a secret that is too short", () => {
      const parsed = parseFragment(secret.slice(1));

      assert.equal(parsed, null);
    });

    test("refuses a character outside the alphabet", () => {
      const parsed = parseFragment(secret.slice(1) + "U");

      assert.equal(parsed, null);
    });
  });
});

describe("keys", () => {
  describe("roomCrypto", () => {
    test("rejects an access key that is too short", async () => {
      const sessionKey = randomSessionKey();

      await assert.rejects(roomCrypto("abc", sessionKey), /bad key format/);
    });

    test("accepts only the canonical access key form", async () => {
      const sessionKey = randomSessionKey();

      await assert.rejects(
        roomCrypto(accessKey.toLowerCase(), sessionKey),
        /bad key format/,
        "only the canonical form",
      );
    });

    test("rejects a 32-byte session key", async () => {
      const sessionKey = new Uint8Array(32);

      await assert.rejects(roomCrypto(accessKey, sessionKey), /bad key format/);
    });

    test("zeroes the session key it was given", async () => {
      const key = randomSessionKey();

      await roomCrypto(accessKey, key);

      assert.ok(key.every((byte) => byte === 0));
    });
  });
});

describe("sealer", () => {
  describe("Sealer", () => {
    describe("open", () => {
      test("opens sealed messages in send order", async () => {
        const [creatorRoom, joinerRoom] = await Promise.all([makeRoomCrypto(), makeRoomCrypto()]);
        const sender = new Sealer(creatorRoom.signal, "sig", "creator");
        const receiver = new Sealer(joinerRoom.signal, "sig", "joiner");
        const numbers = [1, 2, 3];
        const sealed = await Promise.all(numbers.map((number) => sender.seal({ number })));

        // The three messages only mean something as one ordered stream.
        const opened: unknown[] = [];
        for (const sealedMessage of sealed) opened.push(await receiver.open(sealedMessage));

        assert.deepEqual(
          opened,
          numbers.map((number) => ({ number })),
        );
      });

      test("rejects a flipped byte", async () => {
        const room = await makeRoomCrypto();
        const sender = new Sealer(room.signal, "sig", "creator");
        const receiver = new Sealer(room.signal, "sig", "joiner");
        const sealedMessage = await sender.seal("x");
        sealedMessage[20] ^= 1;

        const opening = receiver.open(sealedMessage);

        await assert.rejects(opening);
      });

      test("stays dead after a bad message", async () => {
        const room = await makeRoomCrypto();
        const sender = new Sealer(room.signal, "sig", "creator");
        const receiver = new Sealer(room.signal, "sig", "joiner");
        const sealedMessage = await sender.seal("x");
        sealedMessage[20] ^= 1;
        // The bad open kills the receive stream, so the next open must fail too.
        await receiver.open(sealedMessage).catch(() => {});
        const nextMessage = await sender.seal("y");

        const opening = receiver.open(nextMessage);

        await assert.rejects(opening, "stream stays dead after a bad message");
      });

      test("rejects a replay", async () => {
        const { receiver, sealedMessage } = await sealedFirstMessage();
        await receiver.open(sealedMessage);

        const replay = receiver.open(sealedMessage);

        await assert.rejects(replay, "replay");
      });

      test("rejects a message reflected to the sender's own role", async () => {
        const { room, sealedMessage } = await sealedFirstMessage();
        const reflected = new Sealer(room.signal, "sig", "creator");

        const opening = reflected.open(sealedMessage);

        await assert.rejects(opening, "reflected to the sender's own role");
      });

      test("rejects a message under another label", async () => {
        const { room, sealedMessage } = await sealedFirstMessage();
        const otherLabel = new Sealer(room.signal, "ctl", "joiner");

        const opening = otherLabel.open(sealedMessage);

        await assert.rejects(opening, "other label");
      });

      test("rejects a message sealed with a wrong secret", async () => {
        const { sealedMessage } = await sealedFirstMessage();
        const otherRoom = await makeRoomCrypto(randomSessionKey());
        const wrongSecret = new Sealer(otherRoom.signal, "sig", "joiner");

        const opening = wrongSecret.open(sealedMessage);

        await assert.rejects(opening, "wrong secret");
      });
    });
  });

  describe("openChunk", () => {
    test("returns the chunk sealed at its index", async () => {
      const { transferKey, chunkData, sealedChunk } = await sealedChunkPair();

      const opened = await openChunk(transferKey, 7, sealedChunk);

      assert.deepEqual(opened, chunkData);
    });

    test("refuses a chunk read at another index", async () => {
      const { transferKey, sealedChunk } = await sealedChunkPair();

      const opening = openChunk(transferKey, 8, sealedChunk);

      await assert.rejects(opening);
    });

    test("refuses a chunk from another transfer", async () => {
      const { otherTransferKey, sealedChunk } = await sealedChunkPair();

      const opening = openChunk(otherTransferKey, 7, sealedChunk);

      await assert.rejects(opening);
    });
  });
});
