import { test, expect } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";
import {
  CANCEL_SIZE,
  Peer,
  SMALL,
  createRoom,
  downloaded,
  hasFile,
  joinFromInvite,
  launch,
  midTransfer,
  presetSettings,
  recordPeerConnections,
  registerHooks,
  savedSha,
  status,
  transfer,
} from "./fixtures.ts";

registerHooks();

test("a peer whose socket and peer connection drop rejoins the room: away, then back, then files both ways", async () => {
  const creator = await launch();
  const joiner = await launch();
  await recordPeerConnections(joiner);
  let live: WebSocketRoute | null = null;
  let blocked = false;
  // CPace shares are the only 36-byte binary frames (gen + 32-byte point); a rejoin keeps the room key.
  let shares = 0;
  await joiner.page.routeWebSocket(/\/ws$/, (socket: WebSocketRoute) => {
    if (blocked) return void socket.close();
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (typeof message !== "string" && message.length === 36) shares++;
      server.send(message);
    });
    live = socket;
  });
  const invite = await createRoom(creator);
  await joinFromInvite(joiner, invite);
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");
  // The invite box and the secret leave the creator's page once the peer is in.
  await expect(creator.page.locator("#invite-box")).toBeHidden();
  await expect(creator.page.locator("#invite")).toHaveValue("");
  await expect(creator.page.locator("#show-access")).toHaveValue("");
  await expect(creator.page.locator("#show-secret")).toHaveValue("");
  await expect(creator.page.locator("#invite-qr svg")).toHaveCount(0);

  blocked = true;
  await joiner.page.evaluate(() => (window as unknown as { pcs: RTCPeerConnection[] }).pcs.forEach((pc) => pc.close()));
  await live!.close();
  await expect(status(creator)).toContainText("away", { timeout: 10_000 });
  await expect(status(creator)).toContainText(/[45]:\d\d/);
  await expect(status(joiner)).toContainText("Reconnecting");
  await expect(creator.page.locator("#drop")).toBeHidden();
  await expect(creator.page.locator("#leave")).toBeVisible();

  blocked = false;
  await expect(status(creator)).toContainText("Connected", { timeout: 20_000 });
  await expect(status(joiner)).toContainText("Connected");
  // The reconnect's second open leaves it hidden and empty.
  await expect(creator.page.locator("#invite-box")).toBeHidden();
  await expect(creator.page.locator("#invite")).toHaveValue("");
  await expect(creator.page.locator("#invite-qr svg")).toHaveCount(0);
  await transfer(creator, joiner, "after-rejoin-a.bin", SMALL);
  await transfer(joiner, creator, "after-rejoin-b.bin", SMALL);
  expect(shares, "one key exchange, none after the rejoin").toBe(1);
});

/** The page's socket and peer connections drop and stay down until `restore()`, as in a network outage while the
 *  page stays open. Set up before the page opens the room. */
async function outage(peer: Peer) {
  await recordPeerConnections(peer);
  let live: WebSocketRoute | null = null;
  let blocked = false;
  await peer.page.routeWebSocket(/\/ws$/, (socket: WebSocketRoute) => {
    if (blocked) return void socket.close();
    socket.connectToServer();
    live = socket;
  });

  return {
    async cut() {
      blocked = true;
      await peer.page.evaluate(() =>
        (window as unknown as { pcs: RTCPeerConnection[] }).pcs.forEach((pc) => pc.close()),
      );
      await live!.close();
    },
    restore() {
      blocked = false;
    },
  };
}

/** `E2E_PAUSE_S` holds the outage that long (does a stalled download survive?); the room then keeps 30 min,
 *  and so does the page's rejoin, so keep it under about 1700. */
const PAUSE_S = Number(process.env.E2E_PAUSE_S ?? 0);

/** A connected room whose joiner can lose its network; the creator keeps the room `keepAlive` seconds. */
async function outagePair(
  kind: Peer["kind"] = "chromium",
  opts: { serviceWorkers?: boolean } = {},
  keepAlive = PAUSE_S ? 1800 : 300,
) {
  const creator = await launch();
  const joiner = await launch(kind, opts);
  const outageControl = await outage(joiner);
  if (keepAlive !== 300) await presetSettings(creator, null, false, false, keepAlive);
  await joinFromInvite(joiner, await createRoom(creator));
  if (joiner.kind === "firefox") await joiner.page.waitForFunction(() => navigator.serviceWorker?.controller !== null);
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");

  return { a: creator, b: joiner, net: outageControl };
}

/** Cuts the joiner's network mid-transfer and waits until both rows show the pause with Cancel only. */
async function pauseMidTransfer(
  creator: Peer,
  joiner: Peer,
  outageControl: Awaited<ReturnType<typeof outage>>,
  name: string,
) {
  const started = await midTransfer(creator, joiner, name);
  await outageControl.cut();
  for (const [peer, dir] of [
    [creator, "out"],
    [joiner, "in"],
  ] as const) {
    await expect(peer.page.locator(`#${dir}-text`)).toContainText("Paused", { timeout: 10_000 });
    await expect(peer.page.locator(`#${dir}-cancel`)).toBeVisible();
    expect(
      await peer.page.locator(`#${dir}-bar`).evaluate((e) => (e as HTMLProgressElement).value),
      "cut before the end",
    ).toBeLessThan(1);
    await expect(peer.page.locator("#drop")).toBeHidden();
  }

  return started;
}

for (const [label, kind, opts] of [
  ["Chromium's save picker", "chromium", {}],
  ["Firefox's streamed download", "firefox", {}],
  ["Firefox's OPFS", "firefox", { serviceWorkers: false }],
] as const) {
  test(`a transfer cut by a network outage pauses and finishes after the reconnect into ${label}, recorded once`, async () => {
    test.setTimeout(180_000 + PAUSE_S * 1000);
    const { a: creator, b: joiner, net: outageControl } = await outagePair(kind, opts);
    const name = "resumed.bin";
    const { file, download } = await pauseMidTransfer(creator, joiner, outageControl, name);
    if (PAUSE_S) await creator.page.waitForTimeout(PAUSE_S * 1000);
    outageControl.restore();
    await expect(status(joiner)).toContainText(`Saved ${name}`, { timeout: 120_000 });
    await expect(status(creator)).toContainText("was saved by the other person");
    const saved = download ? await downloaded(await download) : await savedSha(joiner, name);
    expect(saved).toEqual({ size: CANCEL_SIZE, sha: file.sha });
    for (const peer of [creator, joiner]) await expect(peer.page.locator("#history .hist")).toHaveCount(1);
    await expect(creator.page.locator("#history .hist--done")).toHaveCount(1);
    await transfer(joiner, creator, "after-resume.bin", SMALL);
  });
}

for (const cancellingSide of ["sender", "receiver"] as const) {
  test(`the ${cancellingSide} cancels while paused: both end cleanly once reconnected, no partial file, the room still works`, async () => {
    const { a: creator, b: joiner, net: outageControl } = await outagePair();
    const name = "paused-cancel.bin";
    await pauseMidTransfer(creator, joiner, outageControl, name);
    const [canceller, other, dir] = cancellingSide === "sender" ? [creator, joiner, "out"] : [joiner, creator, "in"];
    await canceller.page.click(`#${dir}-cancel`);
    await expect(status(canceller)).toContainText(`You cancelled ${name}`);
    await expect(canceller.page.locator(`#${dir}-row`)).toBeHidden();
    outageControl.restore();
    await expect(status(other)).toContainText(`The other person cancelled ${name}`, { timeout: 30_000 });
    await expect(creator.page.locator("#out-row")).toBeHidden();
    await expect(joiner.page.locator("#in-row")).toBeHidden();
    await expect.poll(() => hasFile(joiner, name)).toBe(false);
    for (const peer of [creator, joiner]) await expect(peer.page.locator("#history .hist--cancelled")).toHaveCount(1);
    await transfer(creator, joiner, "after-paused-cancel.bin", SMALL);
  });
}

test("the keep-alive running out while paused fails the transfer on both sides and keeps no partial file", async () => {
  test.setTimeout(180_000);
  const { a: creator, b: joiner, net: outageControl } = await outagePair("chromium", {}, 60);
  const name = "expired.bin";
  await pauseMidTransfer(creator, joiner, outageControl, name);
  await expect(status(creator)).toContainText("The other person left", { timeout: 90_000 });
  outageControl.restore();
  await expect(status(joiner)).toContainText("The room is gone", { timeout: 30_000 });
  await expect(creator.page.locator("#out-row")).toBeHidden();
  await expect(joiner.page.locator("#in-row")).toBeHidden();
  for (const peer of [creator, joiner]) await expect(peer.page.locator("#history .hist--failed")).toHaveCount(1);
  await expect.poll(() => hasFile(joiner, name)).toBe(false);
});
