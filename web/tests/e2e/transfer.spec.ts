import { test, expect } from "@playwright/test";
import { join } from "node:path";
import {
  CANCEL_SIZE,
  Peer,
  SIZE,
  SMALL,
  connectedPair,
  createRoom,
  downloaded,
  fileSha,
  hasFile,
  joinFromInvite,
  launch,
  makeFile,
  midTransfer,
  offerAndAccept,
  recordRelayFrames,
  registerHooks,
  savedSha,
  status,
  tempDirectory,
  transfer,
} from "./fixtures.ts";

registerHooks();

test("a file goes each way intact, and the relay sees no secret or file metadata", async () => {
  test.setTimeout(Math.max(120_000, SIZE / 1_500));
  const creator = await launch();
  const joiner = await launch();
  const frames = await recordRelayFrames(creator);
  const invite = await createRoom(creator);
  await joinFromInvite(joiner, invite);
  await expect(status(joiner)).toContainText("Connected");

  await transfer(creator, joiner, "a-to-b.bin");
  await transfer(joiner, creator, "b-to-a.bin");
  for (const peer of [creator, joiner]) {
    await expect(peer.page.locator("#history .hist")).toHaveCount(2);
    await expect(peer.page.locator("#history .hist--done")).toHaveCount(2);
  }
  await expect(creator.page.locator("#history .hist-name").first()).toHaveText("b-to-a.bin");

  const secret = new URL(invite).hash.slice(1);
  const relayed = Buffer.concat(frames).toString("latin1");
  expect(frames.length).toBeGreaterThan(2);
  for (const leak of [secret, "a-to-b.bin", "b-to-a.bin", String(SIZE)]) expect(relayed).not.toContain(leak);
});

test("decline: nothing is saved and the sender sees it was declined", async () => {
  const { a: creator, b: joiner } = await connectedPair();
  const file = await makeFile("declined.bin", 1000);
  await creator.page.setInputFiles("#file", file.path);
  await expect(joiner.page.locator("#offer")).toBeVisible();
  await joiner.page.getByRole("button", { name: "Decline" }).click();
  await expect(status(creator)).toContainText("declined declined.bin");
  expect(await hasFile(joiner, "declined.bin")).toBe(false);
  for (const peer of [creator, joiner])
    await expect(peer.page.locator("#history .hist--declined .hist-name")).toHaveText("declined.bin");
});

test("after a decline, the next offers are declined unseen for a few seconds", async () => {
  const { a: creator, b: joiner } = await connectedPair();
  const first = await makeFile("first.bin", 1000);
  const again = await makeFile("again.bin", 1000);
  await creator.page.setInputFiles("#file", first.path);
  await expect(joiner.page.locator("#offer")).toBeVisible();
  await joiner.page.getByRole("button", { name: "Decline" }).click();
  await expect(status(creator)).toContainText("declined first.bin");

  await creator.page.setInputFiles("#file", again.path);
  await expect(status(creator)).toContainText("declined again.bin");
  await expect(joiner.page.locator("#offer")).toBeHidden();
  await expect(joiner.page.locator("#history .hist")).toHaveCount(1);

  await joiner.page.waitForTimeout(5_000);
  await creator.page.setInputFiles("#file", again.path);
  await expect(joiner.page.locator("#offer-name")).toHaveText("again.bin");
});

test("the room info and Connection Info stay while a file is sent; only the drop zone is disabled", async () => {
  const { a: creator, b: joiner } = await connectedPair();
  const file = await makeFile("kept-info.bin", SMALL);
  await creator.page.setInputFiles("#file", file.path);
  await expect(joiner.page.locator("#offer-name")).toHaveText("kept-info.bin");
  // While the offer waits for the answer, the sender keeps the room line and its button; its drop is disabled.
  await expect(creator.page.locator("#room-info")).toBeVisible();
  await expect(creator.page.locator("#conn-btn")).toBeVisible();
  await expect(creator.page.locator("#drop")).toHaveClass(/\bis-disabled\b/);
  await expect(joiner.page.locator("#room-info")).toBeVisible();
  await expect(joiner.page.locator("#conn-btn")).toBeVisible();
  await joiner.page.click("#offer-accept");
  await expect(status(joiner)).toContainText("Saved kept-info.bin", { timeout: 60_000 });
  // The send is over: the drop zone takes the next file again.
  await expect(creator.page.locator("#drop")).not.toHaveClass(/\bis-disabled\b/);
});

test("Chromium to Firefox streams through the Service Worker, and Firefox sends back", async () => {
  test.setTimeout(Math.max(180_000, SIZE / 1_000));
  const { a: creator, b: joiner } = await connectedPair(await launch("firefox"));
  await transfer(creator, joiner, "to-firefox.bin");
  await transfer(joiner, creator, "from-firefox.bin", Math.min(SIZE, 64 << 20));
});

test("Firefox saves through OPFS when the download request bypasses its Service Worker", async () => {
  const joiner = await launch("firefox");
  // The worker files the download under another id, so the frame's /dl/<id> goes to the server, as a Zen once did.
  await joiner.ctx.addInitScript(() => {
    const post = ServiceWorker.prototype.postMessage as (message: unknown, options?: unknown) => void;
    ServiceWorker.prototype.postMessage = function (this: ServiceWorker, message: unknown, options?: unknown) {
      const download = message as { t?: string };
      post.call(this, download?.t === "dl" ? { ...download, id: "x".repeat(22) } : message, options);
    };
  });
  const { a: creator } = await connectedPair(joiner);
  await transfer(creator, joiner, "bypassed.bin", 8 << 20);
});

test("Firefox without Service Workers saves through OPFS", async () => {
  const { a: creator, b: joiner } = await connectedPair(await launch("firefox", { serviceWorkers: false }));
  expect(await joiner.page.evaluate(() => navigator.serviceWorker?.controller ?? null)).toBeNull();
  await transfer(creator, joiner, "via-opfs.bin", 64 << 20);
  await joiner.page.getByRole("button", { name: "Connection Info" }).click();
  await expect(joiner.page.locator("#conn-detail")).toContainText("This side: host");
});

test("iPhone keeps a received file until Save, which hands over the whole file", async () => {
  const { a: creator, b: joiner } = await connectedPair(await launch("iphone"));
  await expect(joiner.page.locator("#ios-note")).toBeVisible();
  const file = await makeFile("to-iphone.bin", 8 << 20);
  await creator.page.setInputFiles("#file", file.path);
  await expect(joiner.page.locator("#offer-accept")).toHaveText("Receive");
  await joiner.page.click("#offer-accept");
  // The whole 8 MB arrives before this text, which can take longer than the default wait under load.
  await expect(status(joiner)).toContainText("to-iphone.bin received. Tap Save", { timeout: 60_000 });
  await expect(status(creator)).toContainText("was saved by the other person");
  const save = joiner.page.locator("#history .hist").first().getByRole("button", { name: "Save" });
  await expect(save).toBeEnabled();
  const [download] = await Promise.all([joiner.page.waitForEvent("download"), save.click()]);
  expect(download.suggestedFilename()).toBe("to-iphone.bin");
  expect(await downloaded(download)).toEqual({ size: 8 << 20, sha: file.sha });
});

test("receiver cancels: both stop, the partial file is removed, the room still works", async () => {
  const { a: creator, b: joiner } = await connectedPair();
  await midTransfer(creator, joiner, "big.bin");
  await joiner.page.click("#in-cancel");
  await expect(status(joiner)).toContainText("You cancelled big.bin");
  await expect(status(creator)).toContainText("The other person cancelled big.bin");
  await expect(creator.page.locator("#out-row")).toBeHidden();
  await expect(joiner.page.locator("#in-row")).toBeHidden();
  await expect.poll(() => hasFile(joiner, "big.bin")).toBe(false);
  await transfer(creator, joiner, "after.bin", SMALL);
});

test("both rows show the time left only after about 3 s of moving bytes, and in the UI language", async () => {
  const { a: creator, b: joiner } = await connectedPair();
  const watch = (p: Peer, dir: string) =>
    p.page.evaluate((id) => {
      const element = document.getElementById(id)!;
      const seen = { still: 0, left: 0 };
      (window as unknown as { seen: typeof seen }).seen = seen;
      new MutationObserver(() => {
        const text = element.textContent ?? "";
        if (!text.includes("/s")) seen.still = performance.now();
        else if (text.includes("left") && !seen.left) seen.left = performance.now();
      }).observe(element, { childList: true, characterData: true, subtree: true });
    }, `${dir}-text`);
  await watch(creator, "out");
  await watch(joiner, "in");
  await offerAndAccept(creator, joiner, "eta.bin", CANCEL_SIZE);
  for (const [peer, dir] of [
    [creator, "out"],
    [joiner, "in"],
  ] as const) {
    await expect(peer.page.locator(`#${dir}-text`)).toContainText(/ · \d+:\d\d left$/);
    const seen = await peer.page.evaluate(() => (window as unknown as { seen: { still: number; left: number } }).seen);
    expect(seen.left - seen.still, `${dir}: time left waits for the warm-up`).toBeGreaterThan(2500);
  }
  await joiner.page.selectOption("#lang", "ru");
  await expect(joiner.page.locator("#in-text")).toContainText("осталось");
  await joiner.page.click("#in-cancel");
});

test("sender cancels: both stop, the partial file is removed, the room still works; the bars glide between renders", async () => {
  const { a: creator, b: joiner } = await connectedPair();
  await midTransfer(creator, joiner, "big.bin");
  // Renders come 4 times a second; a bar that glides between them shows many more distinct values.
  for (const [peer, dir] of [
    [creator, "out"],
    [joiner, "in"],
  ] as const) {
    const seen = await peer.page.locator(`#${dir}-bar`).evaluate(
      (bar) =>
        new Promise<number>((done) => {
          const values = new Set<number>();
          const end = performance.now() + 1000;
          const frame = (now: number) => {
            values.add((bar as HTMLProgressElement).value);
            if (now < end) requestAnimationFrame(frame);
            else done(values.size);
          };
          requestAnimationFrame(frame);
        }),
    );
    expect(seen).toBeGreaterThan(10);
  }
  await creator.page.click("#out-cancel");
  await expect(status(creator)).toContainText("You cancelled big.bin");
  await expect(status(joiner)).toContainText("The other person cancelled big.bin");
  await expect(joiner.page.locator("#in-row")).toBeHidden();
  await expect.poll(() => hasFile(joiner, "big.bin")).toBe(false);
  await transfer(joiner, creator, "after.bin", SMALL);
});

const savedRow = (p: Peer, name: string) => p.page.locator("#history .hist--done .hist-name", { hasText: name });

test("files sent both ways at once on one connection both arrive intact", async () => {
  test.setTimeout(Math.max(120_000, SIZE / 1_500));
  const { a: creator, b: joiner } = await connectedPair();
  const creatorFile = await makeFile("both-a.bin", SIZE);
  const joinerFile = await makeFile("both-b.bin", 32 << 20);
  await creator.page.setInputFiles("#file", creatorFile.path);
  await joiner.page.setInputFiles("#file", joinerFile.path);
  await expect(joiner.page.locator("#offer-name")).toHaveText("both-a.bin");
  await expect(creator.page.locator("#offer-name")).toHaveText("both-b.bin");
  await joiner.page.click("#offer-accept");
  await creator.page.click("#offer-accept");
  const big = { timeout: Math.max(60_000, SIZE / 5_000) };
  await expect(savedRow(joiner, "both-a.bin")).toBeVisible(big);
  await expect(savedRow(creator, "both-b.bin")).toBeVisible(big);
  expect(await savedSha(joiner, "both-a.bin")).toEqual({ size: SIZE, sha: creatorFile.sha });
  expect(await savedSha(creator, "both-b.bin")).toEqual({ size: 32 << 20, sha: joinerFile.sha });
});

for (const cancellingSide of ["sender", "receiver"] as const) {
  test(`the ${cancellingSide} cancels one direction of a two-way transfer: the other keeps running and the next offer arrives intact`, async () => {
    test.setTimeout(180_000);
    const { a: creator, b: joiner } = await connectedPair();
    await midTransfer(creator, joiner, "ab.bin");
    await offerAndAccept(joiner, creator, "ba.bin", CANCEL_SIZE);
    await expect(creator.page.locator("#in-text")).toContainText("/s");
    if (cancellingSide === "sender") await creator.page.click("#out-cancel");
    else await joiner.page.click("#in-cancel");
    await expect(joiner.page.locator("#in-row")).toBeHidden();
    // Under full-suite load the receiver's cancel took 2.3 s to reach the sender during a two-way transfer.
    await expect(creator.page.locator("#out-row")).toBeHidden({ timeout: 15_000 });
    // The leftover chunks of ab.bin must be dropped, not read as the next file's.
    const next = await offerAndAccept(creator, joiner, "next.bin", 8 << 20);
    await expect(savedRow(joiner, "next.bin")).toBeVisible({ timeout: 60_000 });
    expect(await savedSha(joiner, "next.bin")).toEqual({ size: 8 << 20, sha: next.file.sha });
    await expect(savedRow(creator, "ba.bin")).toBeVisible({ timeout: 120_000 });
    expect(await savedSha(creator, "ba.bin")).toEqual(await fileSha(join(tempDirectory, "ba.bin")));
  });
}

/** Keeps every RTCPeerConnection in window.lanePcs with the binary frames sent on its channels: the chunks it carried. */
async function recordLanes(peer: Peer) {
  await peer.ctx.addInitScript(() => {
    const Original = RTCPeerConnection;
    type Rec = { pc: RTCPeerConnection; sent: number };
    const pageWindow = window as unknown as { RTCPeerConnection: unknown; lanePcs: Rec[] };
    pageWindow.lanePcs = [];
    pageWindow.RTCPeerConnection = class extends Original {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        const laneRecord: Rec = { pc: this, sent: 0 };
        pageWindow.lanePcs.push(laneRecord);
        const create = this.createDataChannel.bind(this);
        this.createDataChannel = (label: string, init?: RTCDataChannelInit) => {
          const channel = create(label, init);
          const send = channel.send.bind(channel) as (d: unknown) => void;
          (channel as unknown as { send(d: unknown): void }).send = (data: unknown) => {
            if (typeof data !== "string") laneRecord.sent++;
            send(data);
          };

          return channel;
        };
      }
    };
  });
}

/** Chunks sent on each peer connection, in creation order; index 0 is the room's. */
const laneSends = (p: Peer) =>
  p.page.evaluate(() => (window as unknown as { lanePcs: { sent: number }[] }).lanePcs.map((r) => r.sent));

const lanesClosed = (p: Peer) =>
  p.page.evaluate(() =>
    (window as unknown as { lanePcs: { pc: RTCPeerConnection }[] }).lanePcs
      .slice(1)
      .every((r) => r.pc.connectionState === "closed"),
  );

/** A room where both pages run with `?lanes=n`, so every file goes on n connections from the start. */
async function lanePair(laneCount: number, kinds: [Peer["kind"], Peer["kind"]] = ["chromium", "chromium"]) {
  const creator = await launch(kinds[0]);
  const joiner = await launch(kinds[1]);
  await recordLanes(creator);
  await recordLanes(joiner);
  await creator.page.goto(`/?lanes=${laneCount}`);
  await creator.page.click("#create");
  await expect(status(creator)).toContainText("Room ready");
  const invite = await creator.page.inputValue("#invite");
  await joinFromInvite(joiner, invite.replace("#", `?lanes=${laneCount}#`));
  for (const peer of [creator, joiner])
    if (peer.kind === "firefox") await peer.page.waitForFunction(() => navigator.serviceWorker?.controller !== null);
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");

  return { a: creator, b: joiner };
}

for (const kind of ["chromium", "firefox"] as const) {
  test(`?lanes=3 from ${kind}: the chunks travel on three connections, the file arrives intact, and the extra connections close`, async () => {
    test.setTimeout(Math.max(120_000, SIZE / 1_500));
    const { a: creator, b: joiner } = await lanePair(3, [kind, "chromium"]);
    await transfer(creator, joiner, "lanes.bin");
    const sends = await laneSends(creator);
    expect(
      sends.filter((n) => n > 0),
      `chunks per connection: ${sends.join(",")}`,
    ).toHaveLength(3);
    await expect.poll(() => lanesClosed(creator)).toBe(true);
    await expect.poll(() => lanesClosed(joiner)).toBe(true);
    await transfer(joiner, creator, "lanes-back.bin", SMALL);
  });
}

test("a data connection killed mid-transfer: its chunks go again on the others and the file arrives intact", async () => {
  test.setTimeout(180_000);
  const { a: creator, b: joiner } = await lanePair(3);
  const size = 256 << 20;
  const { file } = await offerAndAccept(creator, joiner, "killed.bin", size);
  await expect.poll(async () => (await laneSends(creator)).slice(1).filter((n) => n > 0).length).toBe(2);
  await creator.page.evaluate(() =>
    (window as unknown as { lanePcs: { pc: RTCPeerConnection }[] }).lanePcs[1].pc.close(),
  );
  const killedAt = (await laneSends(creator))[1];
  await expect(joiner.page.locator("#status")).toContainText("Saved killed.bin", { timeout: 120_000 });
  await expect(creator.page.locator("#status")).toContainText("was saved by the other person");
  expect(await savedSha(joiner, "killed.bin")).toEqual({ size, sha: file.sha });
  expect((await laneSends(creator))[1], "nothing more went on the closed connection").toBe(killedAt);
});

for (const cancellingSide of ["sender", "receiver"] as const) {
  test(`the ${cancellingSide} cancels a transfer on three connections: all of them close and the next file arrives intact`, async () => {
    const { a: creator, b: joiner } = await lanePair(3);
    await midTransfer(creator, joiner, "big-lanes.bin");
    expect((await laneSends(creator)).filter((n) => n > 0).length).toBeGreaterThan(1);
    const peer = cancellingSide === "sender" ? creator : joiner;
    await peer.page.getByRole("button", { name: "Connection Info" }).click();
    await expect(peer.page.locator("#conn-detail")).toContainText(
      `${cancellingSide === "sender" ? "Sending" : "Receiving"} over 3 connections.`,
    );
    await peer.page.keyboard.press("Escape");
    if (cancellingSide === "sender") await creator.page.click("#out-cancel");
    else await joiner.page.click("#in-cancel");
    await expect(creator.page.locator("#out-row")).toBeHidden({ timeout: 15_000 });
    await expect(joiner.page.locator("#in-row")).toBeHidden();
    await expect.poll(() => hasFile(joiner, "big-lanes.bin")).toBe(false);
    await expect.poll(() => lanesClosed(creator)).toBe(true);
    await expect.poll(() => lanesClosed(joiner)).toBe(true);
    await transfer(creator, joiner, "after-lanes.bin", 8 << 20);
  });
}

test("a page loaded past its Service Worker (hard reload) asks to be claimed and ends up controlled", async () => {
  const creator = await launch();
  await creator.page.goto("/");
  await creator.page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const cdpSession = await creator.ctx.newCDPSession(creator.page);
  await Promise.all([creator.page.waitForEvent("load"), cdpSession.send("Page.reload", { ignoreCache: true })]);
  await creator.page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 5_000 });
});

test("cancelling a Firefox streamed download never reports it complete, and the room still works", async () => {
  const { a: creator, b: joiner } = await connectedPair(await launch("firefox"));
  const { download } = await midTransfer(creator, joiner, "big.bin");
  await joiner.page.click("#in-cancel");
  await expect(status(creator)).toContainText("The other person cancelled big.bin");
  // Playwright's Firefox leaves the errored download hanging instead of failing it; it must never succeed.
  const outcome = await Promise.race([
    download!.then((d) => d.failure()),
    new Promise<string>((r) => setTimeout(() => r("still pending"), 3_000)),
  ]);
  expect(outcome).not.toBeNull();
  // While that download hangs, Playwright's mouse clicks no longer reach the Firefox page; a DOM click does.
  await transfer(creator, joiner, "after.bin", SMALL, true);
});
