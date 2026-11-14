import { test } from "node:test";
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
const isk = () => crypto.getRandomValues(new Uint8Array(64));
const sessionKey = isk();
// roomCrypto zeroes what it is given, so each call gets its own copy of the shared session key.
const makeRoomCrypto = (k: Bytes = sessionKey) => roomCrypto(accessKey, k.slice());

test("accessKey is 8 Crockford chars, the secret 6; roomCrypto takes a 64-byte session key and zeroes it", async () => {
  assert.match(accessKey, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.match(secret, /^[0-9A-HJKMNP-TV-Z]{6}$/);
  await assert.rejects(roomCrypto("abc", isk()), /bad key format/);
  await assert.rejects(roomCrypto(accessKey.toLowerCase(), isk()), /bad key format/, "only the canonical form");
  await assert.rejects(roomCrypto(accessKey, new Uint8Array(32)), /bad key format/);
  const key = isk();
  await roomCrypto(accessKey, key);
  assert.ok(key.every((b) => b === 0));
});

test("typed keys normalize: any case, I/L read as 1, O as 0, dashes and spaces dropped, U refused", () => {
  assert.equal(normalizeKey("7k2m-xq9p"), "7K2MXQ9P");
  assert.equal(normalizeKey("il o"), "110");
  assert.equal(normalizeKey("ABCU"), null);
  assert.equal(normalizeKey("AB_C"), null);
  assert.equal(parseAccessKey(" 7k2m xq9p "), "7K2MXQ9P");
  assert.equal(parseAccessKey("7K2MXQ9"), null);
});

test("sealed messages round-trip in order between roles", async () => {
  const [creatorRoom, joinerRoom] = await Promise.all([makeRoomCrypto(), makeRoomCrypto()]);
  const sender = new Sealer(creatorRoom.signal, "sig", "creator");
  const receiver = new Sealer(joinerRoom.signal, "sig", "joiner");
  const sealed = await Promise.all([1, 2, 3].map((n) => sender.seal({ n })));
  for (const [i, sealedMessage] of sealed.entries()) assert.deepEqual(await receiver.open(sealedMessage), { n: i + 1 });
});

test("a flipped byte is rejected and poisons the stream", async () => {
  const room = await makeRoomCrypto();
  const sender = new Sealer(room.signal, "sig", "creator");
  const receiver = new Sealer(room.signal, "sig", "joiner");
  const sealedMessage = await sender.seal("x");
  sealedMessage[20] ^= 1;
  await assert.rejects(receiver.open(sealedMessage));
  await assert.rejects(receiver.open(await sender.seal("y")), "stream stays dead after a bad message");
});

test("replay, reflection and the wrong secret are rejected", async () => {
  const room = await makeRoomCrypto();
  const sender = new Sealer(room.signal, "sig", "creator");
  const sealedMessage = await sender.seal("first");
  const receiver = new Sealer(room.signal, "sig", "joiner");
  await receiver.open(sealedMessage);
  await assert.rejects(receiver.open(sealedMessage), "replay");
  await assert.rejects(
    new Sealer(room.signal, "sig", "creator").open(sealedMessage),
    "reflected to the sender's own role",
  );
  await assert.rejects(new Sealer(room.signal, "ctl", "joiner").open(sealedMessage), "other label");
  const other = await makeRoomCrypto(isk());
  await assert.rejects(new Sealer(other.signal, "sig", "joiner").open(sealedMessage), "wrong secret");
});

test("chunks decrypt only at their own index and transfer", async () => {
  const room = await makeRoomCrypto();
  const fileKeyOne = await fileKey(room, "t1");
  const fileKeyTwo = await fileKey(room, "t2");
  const data = crypto.getRandomValues(new Uint8Array(1000));
  const sealedChunk = await sealChunk(fileKeyOne, 7, data);
  assert.deepEqual(await openChunk(fileKeyOne, 7, sealedChunk), data);
  await assert.rejects(openChunk(fileKeyOne, 8, sealedChunk));
  await assert.rejects(openChunk(fileKeyTwo, 7, sealedChunk));
});

const origin = "https://share.example";
const DEFAULTS: InviteHints = { keepAlive: 300, connection: "auto", shareTurn: false };
const ALL_HINTS: InviteHints[] = [];
for (const keepAlive of [300, 0, 60, 900, 1800] as const)
  for (const connection of ["auto", "relay", "tcp"] as const)
    for (const shareTurn of [false, true]) ALL_HINTS.push({ keepAlive, connection, shareTurn });

test("every hint combination round-trips through 2 config chars, and a default room's config is 00", () => {
  assert.equal(ALL_HINTS.length, 30);
  const seen = new Set<string>();
  for (const hints of ALL_HINTS) {
    const fragment = inviteFragment(secret, hints);
    assert.equal(fragment.length, 8);
    assert.equal(fragment.slice(2), secret);
    seen.add(fragment.slice(0, 2));
    assert.deepEqual(
      Invite.parse(`${origin}/r/${accessKey}#${fragment}`, origin),
      new Invite(accessKey, secret, hints),
    );
    assert.deepEqual(
      Invite.parse(new Invite(accessKey, secret, hints).link(origin), origin),
      new Invite(accessKey, secret, hints),
      "link()",
    );
    assert.deepEqual(
      Invite.fromTyped(accessKey.toLowerCase(), fragment.toLowerCase()),
      new Invite(accessKey, secret, hints),
      "typed",
    );
    assert.deepEqual(parseFragment(fragment.toLowerCase()), { secret: secret, hints }, "typed in lower case");
  }
  assert.equal(seen.size, 30);
  assert.equal(inviteFragment(secret, DEFAULTS).slice(0, 2), "00");
  // 900 s is keep-alive index 3, tcp is connection 2 (bits 3-4), share is bit 5: 3 + 16 + 32 = 51.
  assert.equal(inviteFragment(secret, { keepAlive: 900, connection: "tcp", shareTurn: true }).slice(0, 2), "1K");
});

test("spare config bits are ignored, out-of-range fields make the hints unknown, the secret always survives", () => {
  // Bits 6-9 set on top of a default room ("Y" is 11110 in the high char, bit 5 clear): still a default room.
  assert.deepEqual(parseFragment("Y0" + secret), { secret: secret, hints: DEFAULTS });
  // Keep-alive index 5 or 7, connection index 3: unknown hints, joinable secret.
  for (const config of ["05", "07", "0R"])
    assert.deepEqual(parseFragment(config + secret), { secret: secret, hints: null }, config);
  // A bare 6-char secret is a default room; one or three extra chars are unknown hints.
  assert.deepEqual(parseFragment(secret), { secret: secret, hints: DEFAULTS });
  assert.deepEqual(parseFragment("0" + secret), { secret: secret, hints: null });
  assert.deepEqual(parseFragment("000" + secret), { secret: secret, hints: null });
  // Too short, or a char outside the alphabet, is no key at all.
  assert.equal(parseFragment(secret.slice(1)), null);
  assert.equal(parseFragment(secret.slice(1) + "U"), null);
});

test("an invite carries the three hints and nothing else: no TURN credentials can be encoded", () => {
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

test("Invite.parse takes only this origin's invite links, in any case", () => {
  assert.deepEqual(Invite.parse(`${origin}/r/${accessKey}#${secret}`, origin), new Invite(accessKey, secret, DEFAULTS));
  assert.deepEqual(
    Invite.parse(`${origin}/r/${accessKey.toLowerCase()}#${secret.toLowerCase()}`, origin),
    new Invite(accessKey, secret, DEFAULTS),
  );
  assert.equal(Invite.parse(`https://evil.example/r/${accessKey}#${secret}`, origin), null);
  assert.equal(Invite.parse(`http://share.example/r/${accessKey}#${secret}`, origin), null);
  assert.equal(Invite.parse(`${origin}/r/${accessKey}#${secret.slice(1)}`, origin), null);
  assert.equal(Invite.parse(`${origin}/r/${accessKey}`, origin), null);
  assert.equal(Invite.parse(`${origin}/x/${accessKey}#${secret}`, origin), null);
  assert.equal(Invite.parse(`${origin}/r/${accessKey}?a=1#${secret}`, origin), null);
  assert.equal(Invite.parse(`${origin}/r/${accessKey}0#${secret}`, origin), null);
  assert.equal(Invite.parse("hello world", origin), null);
});
