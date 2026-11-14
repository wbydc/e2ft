import { test, expect } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";
import {
  BASE,
  Peer,
  SMALL,
  createRoom,
  joinFromInvite,
  launch,
  makeFile,
  recordPeerConnections,
  registerHooks,
  status,
  transfer,
} from "./fixtures.ts";

registerHooks();

interface Note {
  title: string;
  body?: string;
  tag?: string;
}

/** Records the notifications this peer would show; `fake` also fakes the Notification API (permission default). */
async function recordNotifications(peer: Peer, opts: { grant?: boolean; fake?: boolean } = {}) {
  if (opts.grant) await peer.ctx.grantPermissions(["notifications"], { origin: BASE });
  await peer.ctx.addInitScript(
    ({ fake, grant }: { fake: boolean; grant: boolean }) => {
      const pageWindow = window as unknown as {
        notes: { title: string; body?: string; tag?: string }[];
        forceHidden: boolean;
      };
      pageWindow.notes = [];
      pageWindow.forceHidden = false;
      ServiceWorkerRegistration.prototype.showNotification = function (title: string, options?: NotificationOptions) {
        pageWindow.notes.push({ title, body: options?.body, tag: options?.tag });

        return Promise.resolve();
      };
      // Headless Chromium reports Notification.permission "denied" even when granted (the Permissions API says granted).
      if (grant) Object.defineProperty(Notification, "permission", { configurable: true, get: () => "granted" });
      if (fake) {
        class FakeNotification {
          public static permission: NotificationPermission = "default";
          public static requestPermission(): Promise<NotificationPermission> {
            FakeNotification.permission = "granted";

            return Promise.resolve("granted");
          }
          constructor(title: string, options?: NotificationOptions) {
            pageWindow.notes.push({ title, body: options?.body, tag: options?.tag });
          }
          public close() {}
        }
        Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true });
      }
      // The page itself is really visible; only-while-hidden is checked through this getter, not a background tab.
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (pageWindow.forceHidden ? "hidden" : "visible"),
      });
    },
    { fake: !!opts.fake, grant: !!opts.grant },
  );
}

const notes = (p: Peer) => p.page.evaluate(() => (window as unknown as { notes: Note[] }).notes);

const clearNotes = (p: Peer) => p.page.evaluate(() => ((window as unknown as { notes: Note[] }).notes.length = 0));

const setHidden = (p: Peer, hidden: boolean) =>
  p.page.evaluate((h) => ((window as unknown as { forceHidden: boolean }).forceHidden = h), hidden);

/** Turns notifications on through Settings, as a user would. */
async function enableNotifications(peer: Peer) {
  await peer.page.goto("/");
  await peer.page.getByRole("button", { name: "Settings" }).click();
  await expect(peer.page.locator("#set-notify")).not.toBeChecked();
  await peer.page.locator("#set-notify").check();
  await expect.poll(() => peer.page.evaluate(() => localStorage.getItem("share-notify"))).toBe("1");
  await peer.page.locator("#set-submit").click();
  await expect(peer.page.locator("#settings")).toBeHidden();
}

test("notifications fire only while the tab is hidden and name the file; an offer's notification is replaced by its end", async () => {
  test.setTimeout(180_000);
  const creator = await launch();
  const joiner = await launch();
  for (const peer of [creator, joiner]) await recordNotifications(peer, { grant: true });
  for (const peer of [creator, joiner]) await enableNotifications(peer);

  const invite = await createRoom(creator);
  await joinFromInvite(joiner, invite);
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");

  // With both tabs visible, neither the offer nor the end raises anything.
  await transfer(creator, joiner, "visible.bin", SMALL);
  expect(await notes(creator)).toEqual([]);
  expect(await notes(joiner)).toEqual([]);

  // The joiner receives while hidden: the offer names the file and size, then its end replaces it by tag.
  const file = await makeFile("notify.bin", SMALL);
  await setHidden(joiner, true);
  await creator.page.setInputFiles("#file", file.path);
  await expect(joiner.page.locator("#offer-name")).toHaveText("notify.bin");
  await expect.poll(async () => (await notes(joiner)).some((n) => n.title === "Incoming File")).toBe(true);
  const offer = (await notes(joiner)).find((n) => n.title === "Incoming File")!;
  expect(offer.body).toContain("notify.bin");
  expect(offer.body).toContain("1 MB");
  await joiner.page.click("#offer-accept");
  await expect(status(joiner)).toContainText("Saved notify.bin", { timeout: 60_000 });
  await expect(status(creator)).toContainText("was saved by the other person");
  await expect.poll(async () => (await notes(joiner)).some((n) => n.title === "File received")).toBe(true);
  const received = (await notes(joiner)).find((n) => n.title === "File received")!;
  expect(received.body).toBe("notify.bin");
  expect(received.tag).toBe(offer.tag);
  expect(await notes(creator)).toEqual([]);

  // The other way round: the hidden creator gets the offer and the end; the visible joiner stays silent.
  await setHidden(creator, true);
  await setHidden(joiner, false);
  await clearNotes(creator);
  await clearNotes(joiner);
  await joiner.page.setInputFiles("#file", file.path);
  await expect(creator.page.locator("#offer-name")).toHaveText("notify.bin");
  await creator.page.click("#offer-accept");
  await expect(status(creator)).toContainText("Saved notify.bin", { timeout: 60_000 });
  await expect(status(joiner)).toContainText("was saved by the other person");
  await expect
    .poll(async () => (await notes(creator)).map((n) => n.title))
    .toEqual(expect.arrayContaining(["Incoming File", "File received"]));
  expect((await notes(creator)).find((n) => n.title === "File received")?.body).toBe("notify.bin");
  expect(await notes(joiner)).toEqual([]);
});

test("a hidden tab is notified when the peer joins and when it comes back, not after its own reconnect", async () => {
  test.setTimeout(120_000);
  const creator = await launch();
  const joiner = await launch();
  for (const peer of [creator, joiner]) await recordNotifications(peer, { grant: true });
  for (const peer of [creator, joiner]) await enableNotifications(peer);
  await recordPeerConnections(joiner);
  const sockets = new Map<Peer, WebSocketRoute>();
  let blocked = false;
  for (const peer of [creator, joiner]) {
    await peer.page.routeWebSocket(/\/ws$/, (socket: WebSocketRoute) => {
      if (blocked && peer === joiner) return void socket.close();
      socket.connectToServer();
      sockets.set(peer, socket);
    });
  }
  const joined = (p: Peer) => notes(p).then((ns) => ns.filter((n) => n.tag === "peer"));
  const peerNote = { title: "The other person is here", body: "You can send files now.", tag: "peer" };

  const invite = await createRoom(creator);
  await setHidden(creator, true);
  await joinFromInvite(joiner, invite);
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");
  await expect.poll(() => joined(creator)).toEqual([peerNote]);
  expect(await notes(joiner), "the visible joiner stays silent").toEqual([]);

  blocked = true;
  await joiner.page.evaluate(() => (window as unknown as { pcs: RTCPeerConnection[] }).pcs.forEach((pc) => pc.close()));
  await sockets.get(joiner)!.close();
  await expect(status(creator)).toContainText("away", { timeout: 10_000 });
  blocked = false;
  await expect(status(creator)).toContainText("Connected", { timeout: 20_000 });
  await expect
    .poll(() => joined(creator), { message: "the peer coming back notifies again" })
    .toEqual([peerNote, peerNote]);

  // The creator's own signalling drops and reseats (rejoined): it says nothing, the joiner sees it come back (peer-back).
  await setHidden(joiner, true);
  await sockets.get(creator)!.close();
  await expect(status(creator)).toContainText("Reconnecting", { timeout: 10_000 });
  await expect(status(creator)).toContainText("Connected", { timeout: 20_000 });
  await expect(status(joiner)).toContainText("Connected");
  await expect.poll(() => joined(joiner)).toEqual([peerNote]);
  expect(await joined(creator), "no notification after its own reconnect").toEqual([peerNote, peerNote]);
});

test("the first home visit offers notifications once: Turn On enables them, No Thanks hides the card, and neither returns", async () => {
  const creator = await launch();
  await recordNotifications(creator, { fake: true });
  await creator.page.goto("/");
  const card = creator.page.locator("#notify-card");
  await expect(card).toBeVisible();
  await creator.page.click("#notify-no");
  await expect(card).toBeHidden();
  await expect.poll(() => creator.page.evaluate(() => localStorage.getItem("share-notify-asked"))).toBe("1");
  await creator.page.reload();
  await expect(card).toBeHidden();
  await creator.page.getByRole("button", { name: "Settings" }).click();
  await expect(creator.page.locator("#set-notify")).not.toBeChecked();
  await creator.page.getByRole("button", { name: "Cancel" }).click();

  const joiner = await launch();
  await recordNotifications(joiner, { fake: true });
  await joiner.page.goto("/");
  await expect(joiner.page.locator("#notify-card")).toBeVisible();
  await joiner.page.click("#notify-on");
  await expect(joiner.page.locator("#notify-card")).toBeHidden();
  await expect.poll(() => joiner.page.evaluate(() => localStorage.getItem("share-notify"))).toBe("1");
  await joiner.page.getByRole("button", { name: "Settings" }).click();
  await expect(joiner.page.locator("#set-notify")).toBeChecked();
  await expect(joiner.page.locator("#set-notify-blocked")).toBeHidden();
  await joiner.page.getByRole("button", { name: "Cancel" }).click();
  await joiner.page.reload();
  await expect(joiner.page.locator("#notify-card")).toBeHidden();

  // No Notification API at all (an iPhone tab): neither the card nor the setting is shown.
  const third = await launch();
  await third.ctx.addInitScript(() => {
    delete (window as unknown as { Notification?: unknown }).Notification;
  });
  await third.page.goto("/");
  await expect(third.page.locator("#notify-card")).toBeHidden();
  await third.page.getByRole("button", { name: "Settings" }).click();
  await expect(third.page.locator("#set-notify-field")).toBeHidden();
});
