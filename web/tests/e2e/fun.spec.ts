import { test, expect } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";
import {
  Peer,
  SMALL,
  connectedPair,
  createRoom,
  joinFromInvite,
  launch,
  makeFile,
  midTransfer,
  recordPeerConnections,
  registerHooks,
  savedSha,
  status,
  transfer,
} from "./fixtures.ts";

registerHooks();

/** Records every one-shot Fun mode class (`is-*`) as `<id or tag>.<class>`, since burst() removes it again. */
async function recordBursts(peer: Peer) {
  await peer.ctx.addInitScript(() => {
    const pageWindow = window as unknown as { bursts: string[] };
    pageWindow.bursts = [];
    new MutationObserver((records) => {
      for (const record of records) {
        const element = record.target as Element;
        for (const className of element.classList)
          if (className.startsWith("is-") && !record.oldValue?.split(" ").includes(className))
            pageWindow.bursts.push(`${element.id || element.localName}.${className}`);
      }
    }).observe(document, { subtree: true, attributeFilter: ["class"], attributeOldValue: true });
  });
}

const bursts = (p: Peer) => p.page.evaluate(() => (window as unknown as { bursts: string[] }).bursts);

/** Turns the on-by-default effects off through Settings; setLively() toggles the class at once, so no reload. */
async function disableFun(peer: Peer) {
  await peer.page.getByRole("button", { name: "Settings" }).click();
  await peer.page.locator("#set-calm").check();
  await peer.page.locator("#set-submit").click();
  await expect(peer.page.locator("html")).not.toHaveClass(/\bfun\b/);
}

/** Turns the effects back on through Settings. */
async function enableFun(peer: Peer) {
  await peer.page.getByRole("button", { name: "Settings" }).click();
  await peer.page.locator("#set-calm").uncheck();
  await peer.page.locator("#set-submit").click();
  await expect(peer.page.locator("html")).toHaveClass(/\bfun\b/);
}

test("Fun mode is on by default, saved per browser and not in the custom room; it shakes a finished transfer on both sides and shows the MM:SS countdown while the peer is away; your own Leave fades out, the peer's booms", async () => {
  const creator = await launch();
  const joiner = await launch();
  await recordPeerConnections(joiner);
  await recordBursts(creator);
  await recordBursts(joiner);
  let live: WebSocketRoute | null = null;
  let blocked = false;
  await joiner.page.routeWebSocket(/\/ws$/, (socket: WebSocketRoute) => {
    if (blocked) return void socket.close();
    socket.connectToServer();
    live = socket;
  });

  for (const peer of [creator, joiner]) {
    await peer.page.goto("/");
    await expect(peer.page.locator("html")).toHaveClass(/\bfun\b/);
    await peer.page.getByRole("button", { name: "Settings" }).click();
    await expect(peer.page.locator("#set-calm")).not.toBeChecked();
    await peer.page.locator("#set-calm").check();
    await peer.page.locator("#set-submit").click();
    await peer.page.reload();
    await expect(peer.page.locator("html")).not.toHaveClass(/\bfun\b/);
    await peer.page.getByRole("button", { name: "Settings" }).click();
    await expect(peer.page.locator("#set-calm")).toBeChecked();
    await peer.page.locator("#set-calm").uncheck();
    await peer.page.locator("#set-submit").click();
    await peer.page.reload();
    await expect(peer.page.locator("html")).toHaveClass(/\bfun\b/);
  }
  await creator.page.getByRole("button", { name: "Create a Custom Room" }).click();
  await expect(creator.page.locator("#set-calm-field")).toBeHidden();
  await creator.page.getByRole("button", { name: "Cancel" }).click();

  const invite = await createRoom(creator);
  // The creator waits for the other side: the listening pulse is up right after "Room ready".
  await expect(creator.page.locator("#waiting")).toBeVisible();
  await joinFromInvite(joiner, invite);
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");
  await expect(creator.page.locator("#waiting")).toBeHidden();
  await expect(joiner.page.locator("#waiting")).toBeHidden();

  const file = await makeFile("fun.bin", SMALL);
  await creator.page.setInputFiles("#file", file.path);
  await expect(joiner.page.locator("#offer-name")).toHaveText("fun.bin");
  // The sender waits for the accept: the pulse shows, the beam stays still, and the accept clears both.
  await expect(creator.page.locator("#waiting")).toBeVisible();
  await expect(creator.page.locator("#out-row")).toHaveClass(/\bis-waiting\b/);
  await joiner.page.click("#offer-accept");
  await expect(creator.page.locator("#waiting")).toBeHidden();
  await expect(creator.page.locator("#out-row")).not.toHaveClass(/\bis-waiting\b/);
  await expect(joiner.page.locator("#status")).toContainText("Saved fun.bin", { timeout: 60_000 });
  await expect(creator.page.locator("#status")).toContainText("was saved by the other person");
  expect(await savedSha(joiner, "fun.bin")).toEqual({ size: SMALL, sha: file.sha });
  await expect.poll(() => bursts(creator)).toEqual(expect.arrayContaining(["main.is-pop", "out-row.is-done"]));
  await expect.poll(() => bursts(joiner)).toEqual(expect.arrayContaining(["main.is-pop", "in-row.is-done"]));
  await expect(creator.page.locator("#out-row")).toBeHidden();
  await expect(joiner.page.locator("#in-row")).toBeHidden();

  blocked = true;
  await joiner.page.evaluate(() => (window as unknown as { pcs: RTCPeerConnection[] }).pcs.forEach((pc) => pc.close()));
  await live!.close();
  await expect(status(creator)).toContainText("away", { timeout: 10_000 });
  await expect(creator.page.locator("#countdown")).toBeVisible();
  await expect(creator.page.locator("#countdown")).toHaveText(/^\d\d:\d\d$/);
  // The joiner's side reconnects: it shows the plug, not the countdown; the creator shows the countdown, not the plug.
  await expect(status(joiner)).toContainText("Reconnecting");
  await expect(joiner.page.locator("#plug")).toBeVisible();
  await expect(joiner.page.locator("#countdown")).toBeHidden();
  await expect(creator.page.locator("#plug")).toBeHidden();
  blocked = false;
  await expect(status(creator)).toContainText("Connected", { timeout: 20_000 });
  // The peer came back while the countdown showed: it plays the defuse, then hides.
  await expect.poll(() => bursts(creator)).toContain("countdown.is-defused");
  await expect(creator.page.locator("#countdown")).toBeHidden();
  await expect(joiner.page.locator("#plug")).toBeHidden();
  await expect(joiner.page.locator("#countdown")).toBeHidden();

  await creator.page.click("#leave");
  await expect.poll(() => bursts(creator)).toContain("main.is-bye");
  await expect.poll(() => bursts(joiner)).toContain("main.is-boom");
  expect(await bursts(creator)).not.toContain("main.is-boom");
  for (const peer of [creator, joiner]) expect(await bursts(peer)).toContain("main.is-assemble");
});

test("Fun mode small touches: Copy Link pops confetti, the theme button turns on click, Connection info draws a direct path", async () => {
  const creator = await launch();
  const joiner = await launch();
  await recordBursts(creator);
  await creator.page.goto("/");
  await expect(creator.page.locator("html")).toHaveClass(/\bfun\b/);
  await creator.page.waitForTimeout(600);
  // The first apply at page load must not play the swap.
  expect(await bursts(creator)).not.toContain("theme.is-swap");

  await creator.ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  await creator.page.click("#theme");
  await expect.poll(() => bursts(creator)).toContain("theme.is-swap");

  const invite = await createRoom(creator);
  await creator.page.click("#copy");
  await expect(creator.page.locator("#copy")).toHaveText("Copied");
  await expect.poll(() => bursts(creator)).toContain("copy.is-confetti");

  // A failed copy selects the link and does not celebrate.
  await creator.page.evaluate(() => {
    (window as unknown as { bursts: string[] }).bursts = [];
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
    });
  });
  await creator.page.click("#copy");
  await creator.page.waitForTimeout(200);
  expect(await bursts(creator)).not.toContain("copy.is-confetti");

  await joinFromInvite(joiner, invite);
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");
  await creator.page.getByRole("button", { name: "Connection Info" }).click();
  await expect(creator.page.locator("#conn-graph")).toHaveClass(/\bis-direct\b/);
  await expect(creator.page.locator("#conn-graph")).toBeVisible();
});

test("Fun mode off: Copy Link, the theme button and Connection info stay plain", async () => {
  const creator = await launch();
  const joiner = await launch();
  await recordBursts(creator);
  await creator.ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  await creator.page.goto("/");
  await disableFun(creator);
  const invite = await createRoom(creator);
  await creator.page.click("#copy");
  await expect(creator.page.locator("#copy")).toHaveText("Copied");
  await creator.page.click("#theme");
  await joinFromInvite(joiner, invite);
  await expect(status(creator)).toContainText("Connected");
  await creator.page.getByRole("button", { name: "Connection Info" }).click();
  await expect(creator.page.locator("#conn-path")).toHaveText(/^Direct/);
  await expect(creator.page.locator("#conn-graph")).toBeHidden();
  const seen = await bursts(creator);
  for (const name of ["copy.is-confetti", "theme.is-swap"]) expect(seen).not.toContain(name);
});

test("with Fun mode off, the waiting pulse, the countdown and the reconnect plug never show", async () => {
  const creator = await launch();
  const joiner = await launch();
  await recordPeerConnections(joiner);
  await recordBursts(creator);
  let live: WebSocketRoute | null = null;
  let blocked = false;
  await joiner.page.routeWebSocket(/\/ws$/, (socket: WebSocketRoute) => {
    if (blocked) return void socket.close();
    socket.connectToServer();
    live = socket;
  });
  const glyphs = ["#waiting", "#countdown", "#plug"];
  const allHidden = async (peer: Peer) => {
    for (const id of glyphs) await expect(peer.page.locator(id)).toBeHidden();
  };

  for (const peer of [creator, joiner]) {
    await peer.page.goto("/");
    await disableFun(peer);
  }
  const invite = await createRoom(creator);
  await allHidden(creator);
  await joinFromInvite(joiner, invite);
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");
  await allHidden(creator);
  await allHidden(joiner);

  blocked = true;
  await joiner.page.evaluate(() => (window as unknown as { pcs: RTCPeerConnection[] }).pcs.forEach((pc) => pc.close()));
  await live!.close();
  await expect(status(joiner)).toContainText("Reconnecting", { timeout: 10_000 });
  await allHidden(joiner);
  await expect(status(creator)).toContainText("away", { timeout: 10_000 });
  await allHidden(creator);

  blocked = false;
  await expect(status(creator)).toContainText("Connected", { timeout: 20_000 });
  await expect(status(joiner)).toContainText("Connected");
  await allHidden(creator);
  await allHidden(joiner);
  expect(await bursts(creator)).not.toContain("countdown.is-defused");
});

/** One-shot classes of the file-flow effects, as recorded by recordBursts. */
const FLOW_BURSTS = ["drop.is-fire", "offer.is-arrive", "in-row.is-zip", "li.is-land"];

test("Fun mode animates the file flow: the drop fires, the offer slides in, Accept zips into the receiving bar and history rows land", async () => {
  const creator = await launch();
  const joiner = await launch();
  await recordBursts(creator);
  await recordBursts(joiner);

  // Off: the same transfer adds none of the flow effects and no check icon.
  for (const peer of [creator, joiner]) {
    await peer.page.goto("/");
    await disableFun(peer);
  }
  const invite = await createRoom(creator);
  await joinFromInvite(joiner, invite);
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");
  await transfer(creator, joiner, "plain.bin", SMALL);
  for (const peer of [creator, joiner]) {
    const seen = await bursts(peer);
    for (const className of FLOW_BURSTS) expect(seen).not.toContain(className);
    await expect(peer.page.locator("#history .hist-check")).toHaveCount(0);
  }

  // On: turn Fun mode back on in both browsers, then a fresh room and a transfer that saves through the picker path.
  for (const peer of [creator, joiner]) {
    await peer.page.goto("/");
    await enableFun(peer);
  }
  const funInvite = await createRoom(creator);
  await joinFromInvite(joiner, funInvite);
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");
  await transfer(creator, joiner, "fun-flow.bin", SMALL);

  await expect
    .poll(() => bursts(creator))
    .toEqual(expect.arrayContaining(["drop.is-fire", "out-row.is-done", "li.is-land"]));
  await expect
    .poll(() => bursts(joiner))
    .toEqual(expect.arrayContaining(["offer.is-arrive", "in-row.is-zip", "in-row.is-done", "li.is-land"]));
  await expect(joiner.page.locator("#history .hist-check")).toHaveCount(1);
});

test("Fun mode puts a sparking orb on the speed graph's leading edge, and Fun mode off hides it", async () => {
  const { a: creator, b: joiner } = await connectedPair();
  for (const peer of [creator, joiner]) await disableFun(peer);
  await midTransfer(creator, joiner, "bolt.bin");
  // Off: the spell sits in the DOM as hidden decoration while the transfer runs.
  for (const [peer, dir] of [
    [creator, "out"],
    [joiner, "in"],
  ] as const) {
    await expect(peer.page.locator(`#${dir}-track .spell`)).toBeHidden();
  }

  // Turning Fun mode on mid-transfer draws the spell, without a reload.
  for (const [peer, dir] of [
    [creator, "out"],
    [joiner, "in"],
  ] as const) {
    await enableFun(peer);
    const track = peer.page.locator(`#${dir}-track`);
    const spell = track.locator(".spell");
    await expect(spell).toBeVisible();
    // --p places the orb at the graph's edge and --h at the current speed's height.
    for (const property of ["--p", "--h"]) {
      await expect
        .poll(() => track.evaluate((e, name) => Number(getComputedStyle(e).getPropertyValue(name)), property))
        .toBeGreaterThan(0);
    }
    await expect(spell.locator(".spell-head")).toBeVisible();
    await expect(spell.locator(".spell-head")).toHaveCSS("animation-name", "spell-pulse");
  }
  await creator.page.click("#out-cancel");
  await expect(creator.page.locator("#out-row")).toBeHidden();
  await expect(joiner.page.locator("#in-row")).toBeHidden();
});

test("reduce-motion starts animations off, a saved choice wins, the old share-fun key is dropped, and the Join dialog hides the box", async () => {
  // (a) No saved choice under prefers-reduced-motion: no fun class, box checked; unchecking sticks across reloads.
  const calm = await launch("chromium", { reducedMotion: "reduce" });
  await calm.page.goto("/");
  await expect(calm.page.locator("html")).not.toHaveClass(/\bfun\b/);
  await calm.page.getByRole("button", { name: "Settings" }).click();
  await expect(calm.page.locator("#set-calm")).toBeChecked();
  await calm.page.locator("#set-calm").uncheck();
  await calm.page.locator("#set-submit").click();
  await calm.page.reload();
  await expect(calm.page.locator("html")).toHaveClass(/\bfun\b/);

  // (b) A stale old-key value still gives the effects, and the key is dropped on load.
  const stale = await launch();
  await stale.page.goto("/");
  await stale.page.evaluate(() => localStorage.setItem("share-fun", ""));
  await stale.page.reload();
  await expect(stale.page.locator("html")).toHaveClass(/\bfun\b/);
  expect(await stale.page.evaluate(() => localStorage.getItem("share-fun"))).toBeNull();

  // (c) The Join dialog offers no "Disable animations" box.
  const host = await launch();
  const invite = await createRoom(host);
  const joiner = await launch();
  await joiner.page.goto(invite);
  await expect(joiner.page.locator("#settings")).toBeVisible();
  await expect(joiner.page.locator("#set-calm-field")).toBeHidden();
});
