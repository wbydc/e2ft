import { createServer, connect } from "node:net";
import type { Socket } from "node:net";
import { test, expect } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";
import { BASE, SMALL, launch, recordPeerConnections, registerHooks, status, transfer } from "./fixtures.ts";
import type { Peer } from "./fixtures.ts";

registerHooks();

/** Turns on "Visible to devices on my network" in Settings under this name, as a person does. */
async function makeVisible(peer: Peer, name: string, url = "/") {
  await peer.page.goto(url);
  await peer.page.click("#settings-btn");
  await peer.page.check("#set-visible");
  await peer.page.fill("#set-name", name);
  await peer.page.click("#set-submit");
  await expect(peer.page.locator("#devices-self")).toContainText(name);
}

const listed = (peer: Peer) => peer.page.locator("#devices button");

/** Two visible devices; `asker` taps `accepter`, which accepts, so both reach the compare dialog. */
async function comparingPair(): Promise<{ asker: Peer; accepter: Peer }> {
  const asker = await launch();
  const accepter = await launch("firefox");
  await makeVisible(asker, "Asker Laptop");
  await makeVisible(accepter, "Accepter Phone");
  await expect(listed(asker)).toHaveText(/Accepter Phone.*Firefox/);
  await expect(listed(accepter)).toHaveText(/Asker Laptop.*Chrome/);

  await listed(asker).click();
  await expect(asker.page.locator("#devices-note")).toContainText("Waiting for Accepter Phone");
  await expect(accepter.page.locator("#ask-text")).toContainText("Asker Laptop");
  await accepter.page.click("#ask-accept");
  for (const peer of [asker, accepter]) await expect(peer.page.locator("#compare")).toBeVisible();

  return { asker, accepter };
}

/** The binary frames this page sends and receives on /ws: the key exchange, then sealed messages. */
async function recordBinary(peer: Peer): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  await peer.page.routeWebSocket(/\/ws$/, (socket: WebSocketRoute) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (typeof message !== "string") frames.push(message);
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message !== "string") frames.push(message);
      socket.send(message);
    });
  });

  return frames;
}

test("two visible devices find each other, compare the same code and send a file", async () => {
  const { asker, accepter } = await comparingPair();
  const code = await asker.page.locator("#compare-code").innerText();
  expect(code).toMatch(/^\d{3} \d{3}$/);
  await expect(accepter.page.locator("#compare-code")).toHaveText(code);
  await expect(accepter.page.locator("#invite-box")).toBeHidden();

  await asker.page.click("#compare-yes");
  // One confirmation is not enough: the room waits for the other screen.
  await expect(status(asker)).not.toContainText("Connected");
  await accepter.page.click("#compare-yes");
  for (const peer of [asker, accepter]) await expect(status(peer)).toContainText("Connected");

  await transfer(asker, accepter, "found.bin", SMALL);
});

for (const refuser of ["asker", "accepter"] as const) {
  test(`"No Match" on the ${refuser} ends the room before any connection is offered`, async () => {
    const asker = await launch();
    const accepter = await launch("firefox");
    const frames = await recordBinary(asker);
    for (const peer of [asker, accepter]) await recordPeerConnections(peer);
    await makeVisible(asker, "Asker Laptop");
    await makeVisible(accepter, "Accepter Phone");
    await listed(asker).click();
    await accepter.page.click("#ask-accept");
    for (const peer of [asker, accepter]) await expect(peer.page.locator("#compare")).toBeVisible();

    const [no, yes] = refuser === "asker" ? [asker, accepter] : [accepter, asker];
    await yes.page.click("#compare-yes");
    await no.page.click("#compare-no");
    await expect(status(no)).toContainText("codes did not match");
    await expect(status(yes)).toContainText("did not confirm the code");

    // Commitment, two shares, two tags, then at most the one sealed "match": an SDP frame would be far larger.
    expect(frames.length).toBeLessThanOrEqual(6);
    for (const frame of frames) expect(frame.byteLength).toBeLessThan(100);
    for (const peer of [asker, accepter]) {
      expect(await peer.page.evaluate(() => (window as unknown as { pcs: unknown[] }).pcs.length)).toBe(0);
    }
  });
}

test("a new pairing after the joiner sent its share ends the room instead of restarting the exchange", async () => {
  const asker = await launch();
  const accepter = await launch();
  // A relay that wants a second share from the joiner: after the first one, it announces the next pairing.
  await asker.page.routeWebSocket(/\/ws$/, (socket: WebSocketRoute) => {
    const server = socket.connectToServer();
    let gen = 0;
    server.onMessage((message) => {
      if (typeof message === "string") gen = (JSON.parse(message) as { gen?: number }).gen ?? gen;
      socket.send(message);
    });
    socket.onMessage((message) => {
      if (typeof message === "string") return server.send(message);

      socket.send(JSON.stringify({ t: "peer-back", iceServers: [], gen: gen + 1, keepAlive: 300 }));
    });
  });
  await makeVisible(asker, "Asker Laptop");
  await makeVisible(accepter, "Accepter Phone");
  await listed(asker).click();
  await accepter.page.click("#ask-accept");

  await expect(status(asker)).toContainText("did not verify");
  await expect(asker.page.locator("#compare")).toBeHidden();
});

test("a declined ask leaves both on the home page", async () => {
  const asker = await launch();
  const accepter = await launch();
  await makeVisible(asker, "Asker Laptop");
  await makeVisible(accepter, "Accepter Phone");
  await listed(asker).click();
  await accepter.page.locator("#ask button[value=decline]").click();
  await expect(asker.page.locator("#devices-note")).toContainText("declined");
  await expect(listed(asker)).toBeEnabled();
  for (const peer of [asker, accepter]) await expect(peer.page.locator("#home")).toBeVisible();
});

test("a device with the setting off neither shows nor sees others", async () => {
  const first = await launch();
  const second = await launch();
  const hidden = await launch();
  await hidden.page.goto("/");
  await makeVisible(first, "First");
  await makeVisible(second, "Second");
  await expect(listed(first)).toHaveText(/Second/);
  await expect(listed(second)).toHaveText(/First/);

  await expect(listed(first)).toHaveCount(1);
  await expect(hidden.page.locator("#devices-box")).toBeHidden();
  expect(
    await hidden.page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name)),
  ).not.toContainEqual(expect.stringContaining("/discover"));

  // Turning it off again takes the device off the other's list.
  await second.page.click("#settings-btn");
  await second.page.uncheck("#set-visible");
  await second.page.click("#set-submit");
  await expect(listed(first)).toHaveCount(0);
  await expect(second.page.locator("#devices-box")).toBeHidden();
});

test("a socket that floods hello is closed and the other page keeps its list", async () => {
  const watcher = await launch();
  const flooder = await launch();
  await makeVisible(watcher, "Watcher");
  await makeVisible(flooder, "Listed");
  await expect(listed(watcher)).toHaveText(/Listed/);

  const closed = await flooder.page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/discover`);
        socket.onopen = () => {
          for (let i = 0; i < 10; i++) socket.send(JSON.stringify({ t: "hello", name: `Flood ${i}`, device: "Bot" }));
        };
        socket.onclose = () => resolve(true);
        setTimeout(() => resolve(false), 5000);
      }),
  );
  expect(closed).toBe(true);

  await expect(listed(watcher)).toHaveCount(1);
  await expect(listed(watcher)).toHaveText(/Listed/);
});

test("a device declined once is declined again without a dialog for 30 seconds", async () => {
  const asker = await launch();
  const accepter = await launch();
  await accepter.page.clock.install();
  await makeVisible(asker, "Asker Laptop");
  await makeVisible(accepter, "Accepter Phone");
  await listed(asker).click();
  await accepter.page.locator("#ask button[value=decline]").click();
  await expect(asker.page.locator("#devices-note")).toContainText("declined");

  await listed(asker).click();
  await expect(asker.page.locator("#devices-note")).toContainText("declined");
  await expect(accepter.page.locator("#ask")).toBeHidden();

  await accepter.page.clock.fastForward(31_000);
  await listed(asker).click();
  await expect(accepter.page.locator("#ask-text")).toContainText("Asker Laptop");
});

/** A TCP proxy in front of the server whose `silence()` stops passing the browser's bytes on and keeps every
 *  connection open, the way a phone that switched networks leaves its old socket: the server's pings go unanswered. */
async function silenceableProxy(): Promise<{ url: string; silence: () => void }> {
  const target = new URL(BASE);
  const clients: Socket[] = [];
  const proxy = createServer((client) => {
    const server = connect(Number(target.port), target.hostname);
    client.pipe(server);
    server.pipe(client);
    clients.push(client);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address() as { port: number };

  return {
    url: `http://127.0.0.1:${address.port}/`,
    silence: () => {
      for (const client of clients) {
        client.unpipe();
        client.pause();
      }
    },
  };
}

test("a device that loses its network leaves the other page's list within 20 seconds", async () => {
  const watcher = await launch();
  const leaver = await launch();
  const proxy = await silenceableProxy();
  await makeVisible(watcher, "Watcher");
  await makeVisible(leaver, "Leaver", proxy.url);
  await expect(listed(watcher)).toHaveText(/Leaver/);

  proxy.silence();
  await expect(listed(watcher)).toHaveCount(0, { timeout: 20_000 });
});
