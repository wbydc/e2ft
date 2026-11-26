import { test, expect } from "@playwright/test";
import {
  CANCEL_SIZE,
  OWN_TURN,
  Peer,
  SMALL,
  downloaded,
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

/** Needs the local coturns: CI runs these, and only these, in the job that starts them (`--grep @turn`). */
const TURN = { tag: "@turn" };

/** A connected room where both sides have their own TURN server and run with `?slow=1`, so the Relay over TCP
 *  suggestion shows as soon as a transfer runs. */
async function slowPair(kind: Peer["kind"]) {
  const creator = await launch();
  const joiner = await launch(kind);
  await recordPeerConnections(joiner);
  for (const peer of [creator, joiner]) await presetSettings(peer, OWN_TURN);
  await creator.page.goto("/?slow=1");
  await creator.page.click("#create");
  await expect(status(creator)).toContainText("Room ready");
  const invite = await creator.page.inputValue("#invite");
  await joiner.page.goto(invite.replace("#", "?slow=1#"));
  await joiner.page.locator("#set-submit").click();
  if (joiner.kind === "firefox") await joiner.page.waitForFunction(() => navigator.serviceWorker?.controller !== null);
  for (const peer of [creator, joiner]) await expect(status(peer)).toContainText("Connected", { timeout: 20_000 });

  return { creator, joiner };
}

/** Opens Connection Info and returns its route line and details. */
async function connInfo(peer: Peer) {
  await peer.page.getByRole("button", { name: "Connection Info" }).click();
  await expect(peer.page.locator("#conn-detail")).toContainText("This side:");
  const route = {
    path: await peer.page.locator("#conn-path").textContent(),
    detail: await peer.page.locator("#conn-detail").textContent(),
  };
  await peer.page.locator("#conn").getByRole("button", { name: "Close" }).click();

  return route;
}

for (const kind of ["chromium", "firefox"] as const) {
  test(
    `a slow transfer to ${kind}: the sender asks to switch to Relay over TCP, the receiver accepts, the room reconnects relayed over TCP and the file arrives intact (needs E2E_TURN=1)`,
    TURN,
    async () => {
      test.skip(!process.env.E2E_TURN, "no local coturn");
      const { creator, joiner } = await slowPair(kind);
      const name = "switched.bin";
      const { file, download } = await midTransfer(creator, joiner, name);
      for (const peer of [creator, joiner]) await expect(peer.page.locator("#slow-card")).toBeVisible();

      await creator.page.locator("#slow-switch").click();
      await expect(joiner.page.locator("#switch")).toBeVisible();
      await joiner.page.locator("#switch-accept").click();

      for (const peer of [creator, joiner]) {
        await expect(peer.page.locator("#slow-card")).toBeHidden();
        await expect(peer.page.locator("#room-info")).toContainText("Relay only, over TCP.", { timeout: 20_000 });
      }
      await expect(joiner.page.locator("#in-text"), "the transfer resumed on the new connection").toContainText("/s", {
        timeout: 20_000,
      });
      expect(await status(joiner).textContent(), "still running after the switch").not.toContain(`Saved ${name}`);
      await expect(status(joiner)).toContainText(`Saved ${name}`, { timeout: 120_000 });
      await expect(status(creator)).toContainText("was saved by the other person");
      const saved = download ? await downloaded(await download) : await savedSha(joiner, name);
      expect(saved).toEqual({ size: CANCEL_SIZE, sha: file.sha });
      for (const peer of [creator, joiner]) {
        const route = await connInfo(peer);
        expect(route.path).toMatch(/^Through the TURN relay/);
        expect(route.detail).toMatch(/^This side: relay, other side: relay, TCP/);
      }
      expect(
        await joiner.page.evaluate(() =>
          (window as unknown as { pcs: RTCPeerConnection[] }).pcs.at(-1)!.getConfiguration(),
        ),
        "the new connection is relay-only, every TURN URL over TCP",
      ).toMatchObject({ iceTransportPolicy: "relay", iceServers: [{ urls: [`${OWN_TURN.urls}?transport=tcp`] }] });
    },
  );
}

test("the receiver declines the switch: the room stays direct, and the suggestion does not come back in that room, also after a reconnect", async () => {
  const { creator, joiner } = await slowPair("chromium");
  await midTransfer(creator, joiner, "declined-switch.bin");
  await expect(creator.page.locator("#slow-card")).toBeVisible();

  await creator.page.locator("#slow-switch").click();
  await joiner.page.locator("#switch").getByRole("button", { name: "Decline" }).click();

  await expect(status(creator)).toContainText("The other person kept the current connection.");
  for (const peer of [creator, joiner]) await expect(peer.page.locator("#slow-card")).toBeHidden();
  await expect(status(joiner)).toContainText("Saved declined-switch.bin", { timeout: 120_000 });
  await joiner.page.evaluate(() =>
    (window as unknown as { pcs: RTCPeerConnection[] }).pcs.forEach((connection) => connection.close()),
  );
  for (const peer of [creator, joiner]) await expect(status(peer)).toContainText("Connected", { timeout: 30_000 });
  await transfer(creator, joiner, "after-decline.bin", SMALL);
  for (const peer of [creator, joiner]) {
    await expect(peer.page.locator("#slow-card")).toBeHidden();
    await expect(peer.page.locator("#room-info")).not.toContainText("Relay only");
    expect((await connInfo(peer)).path).toMatch(/^Direct/);
  }
});
