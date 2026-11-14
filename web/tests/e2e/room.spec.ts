import { test, expect } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { ROOM_WAIT } from "../../playwright.config.ts";
import { BASE, connectedPair, createRoom, joinFromInvite, launch, registerHooks, status } from "./fixtures.ts";

registerHooks();

test("connection info shows a direct path with its candidate types", async () => {
  const { a: creator } = await connectedPair();
  await creator.page.getByRole("button", { name: "Connection Info" }).click();
  await expect(creator.page.locator("#conn-path")).toHaveText(/^Direct between your browsers/);
  await expect(creator.page.locator("#conn-detail")).toContainText("This side: host");
});

test("a third browser gets room full", async () => {
  const { a: creator, invite } = await connectedPair();
  const third = await launch();
  await joinFromInvite(third, invite);
  await expect(status(third)).toContainText("Room is full");
  await expect(status(creator)).toContainText("Connected");
});

test("closing a tab shows peer left within 2 s, and the room is gone", async () => {
  const { a: creator, b: joiner, invite } = await connectedPair();
  await joiner.page.close();
  await expect(status(creator)).toContainText("left", { timeout: 2_000 });
  const third = await launch();
  await joinFromInvite(third, invite);
  await expect(status(third)).toContainText("Room not found");
  await creator.page.getByRole("button", { name: /^Create a New Room/ }).click();
  await expect(status(creator)).toContainText("Room ready");
  expect(new URL(creator.page.url()).search).toBe("");
});

test("a room nobody joins in time ends with the invite expired, and its invite is refused", async () => {
  const creator = await launch();
  const invite = await createRoom(creator);
  await expect(status(creator)).toContainText("invite expired", { timeout: (ROOM_WAIT + 10) * 1000 });
  const late = await launch();
  await joinFromInvite(late, invite);
  await expect(status(late)).toContainText("Room not found");
});

for (const kind of ["chromium", "firefox"] as const) {
  test(`opening another invite in the same tab (${kind}) leaves the room: the peer sees left, not away`, async () => {
    const creator = await launch();
    const joiner = await launch(kind);
    const invite1 = await createRoom(creator);
    await joinFromInvite(joiner, invite1);
    if (joiner.kind === "firefox")
      await joiner.page.waitForFunction(() => navigator.serviceWorker?.controller !== null);
    await expect(status(creator)).toContainText("Connected");

    const secondCreator = await launch();
    const invite2 = await createRoom(secondCreator);
    await joinFromInvite(joiner, invite2);
    await expect(status(secondCreator)).toContainText("Connected");
    await expect(status(joiner)).toContainText("Connected");

    await expect(status(creator)).toContainText("left", { timeout: 3_000 });
    await expect(status(creator)).not.toContainText("away");
    await expect(status(joiner)).not.toContainText("away");
  });
}

test("a tampered signalling frame fails the connection instead of connecting", async () => {
  const creator = await launch();
  const joiner = await launch();
  await joiner.page.routeWebSocket(/\/ws$/, (socket: WebSocketRoute) => {
    const server = socket.connectToServer();
    // The first two binary frames are the creator's CPace share and tag (a flipped share reads as a wrong key); the
    // third is the first sealed signalling frame.
    let binary = 0;
    server.onMessage((message) => {
      if (typeof message === "string" || ++binary !== 3) return socket.send(message);
      const buffer = Buffer.from(message);
      buffer[buffer.length - 1] ^= 1;
      socket.send(buffer);
    });
  });
  const invite = await createRoom(creator);
  await joinFromInvite(joiner, invite);
  await expect(status(joiner)).toContainText("did not verify");
  await expect(status(creator)).toContainText("left");
  await expect(creator.page.locator("#file")).toBeDisabled();
  await expect(joiner.page.locator("#file")).toBeDisabled();
});

/** A raw /ws client, to check the server's room rules without a page. */
function rawSocket(hello: object) {
  const socket = new WebSocket(BASE.replace("http", "ws") + "/ws");
  const queue: string[] = [];
  const waiters: ((s: string) => void)[] = [];
  socket.onmessage = (event) => {
    const waiter = waiters.shift();
    if (waiter) waiter(String(event.data));
    else queue.push(String(event.data));
  };
  socket.onopen = () => socket.send(JSON.stringify(hello));
  const next = async () =>
    JSON.parse(await new Promise<string>((r) => (queue.length ? r(queue.shift()!) : waiters.push(r))));

  return { ws: socket, next };
}

const key = () => randomBytes(16).toString("base64url");

const roomKey = () => randomBytes(6).toString("base64url");

test("a creator who leaves before anyone joins sees no invite box, link, QR or keys", async () => {
  const creator = await launch();
  await createRoom(creator);
  await expect(creator.page.locator("#invite-box")).toBeVisible();
  await creator.page.click("#leave");
  await expect(creator.page.locator("#invite-box")).toBeHidden();
  await expect(creator.page.locator("#invite")).toHaveValue("");
  await expect(creator.page.locator("#show-access")).toHaveValue("");
  await expect(creator.page.locator("#show-secret")).toHaveValue("");
  await expect(creator.page.locator("#invite-qr svg")).toHaveCount(0);
});

test("the server refuses a forged keep-alive and a rejoin without the seat's token; Off ends the room on a drop", async () => {
  expect(await rawSocket({ t: "create", room: roomKey(), token: key(), keepAlive: 3600 }).next()).toEqual({
    t: "error",
    e: "keep-alive",
  });

  const room = roomKey();
  const joinerToken = key();
  const creator = rawSocket({ t: "create", room, token: key() });
  expect(await creator.next()).toEqual({ t: "created" });
  const joiner = rawSocket({ t: "join", room, token: joinerToken });
  expect(await joiner.next()).toMatchObject({ t: "joined", keepAlive: 300 });
  expect(await creator.next()).toMatchObject({ t: "peer-joined", keepAlive: 300 });
  joiner.ws.close();
  const away = await creator.next();
  expect(away.t).toBe("peer-away");
  expect(away.wait).toBeGreaterThan(295);
  expect(await rawSocket({ t: "rejoin", room, token: key(), role: "joiner" }).next()).toEqual({
    t: "error",
    e: "not-found",
  });
  expect(await rawSocket({ t: "join", room, token: key() }).next()).toEqual({ t: "error", e: "full" });
  const back = rawSocket({ t: "rejoin", room, token: joinerToken, role: "joiner" });
  expect(await back.next()).toMatchObject({ t: "rejoined", gen: 2, keepAlive: 300 });
  expect(await creator.next()).toMatchObject({ t: "peer-back", gen: 2, keepAlive: 300 });
  creator.ws.close();
  back.ws.close();

  const offRoom = roomKey();
  const offCreator = rawSocket({ t: "create", room: offRoom, token: key(), keepAlive: 0 });
  expect(await offCreator.next()).toEqual({ t: "created" });
  const offJoiner = rawSocket({ t: "join", room: offRoom, token: key() });
  expect(await offJoiner.next()).toMatchObject({ t: "joined", keepAlive: 0 });
  await offCreator.next();
  offJoiner.ws.close();
  expect(await offCreator.next()).toEqual({ t: "peer-left" });
  expect(await rawSocket({ t: "join", room: offRoom, token: key() }).next()).toEqual({ t: "error", e: "not-found" });
});
