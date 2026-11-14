// The server's own TURN path against a real coturn (scripts/coturn.sh start): the server signs short-lived
// credentials with TURN_SECRET, coturn checks them with the same secret, and both browsers relay through it.
import { test, expect } from "@playwright/test";
import {
  SMALL,
  joinFromInvite,
  lastIce,
  launch,
  recordPeerConnections,
  registerHooks,
  status,
  transfer,
} from "../e2e/fixtures.ts";
import type { Peer } from "../e2e/fixtures.ts";
import { WRONG_SECRET_URL } from "../../playwright.integration.config.ts";

registerHooks();

/** The same invite with `?relay=1`, so the joiner too may only use relay candidates. */
function relayOnly(invite: string): string {
  const url = new URL(invite);
  url.searchParams.set("relay", "1");

  return url.href;
}

/** Creates a room on `origin` as a browser that may only relay, and joins it from the other one. */
async function relayedRoom(creator: Peer, joiner: Peer, origin = "") {
  await creator.page.goto(`${origin}/?relay=1`);
  await creator.page.click("#create");
  await expect(status(creator)).toContainText("Room ready");
  await joinFromInvite(joiner, relayOnly(await creator.page.inputValue("#invite")));
}

/** The candidate type of this browser's end of the selected pair on its first peer connection. */
const selectedLocalType = (peer: Peer) =>
  peer.page.evaluate(async () => {
    const stats = await (window as unknown as { pcs: RTCPeerConnection[] }).pcs[0].getStats();
    const pair = [...stats.values()].find(
      (report) =>
        report.type === "candidate-pair" && report.state === "succeeded" && (report.selected ?? report.nominated),
    );

    return stats.get(pair.localCandidateId).candidateType as string;
  });

test("both browsers relay through coturn with the credentials the server signs, and a file arrives intact", async () => {
  const creator = await launch("chromium");
  const joiner = await launch("firefox");
  for (const peer of [creator, joiner]) await recordPeerConnections(peer);

  await relayedRoom(creator, joiner);
  await joiner.page.waitForFunction(() => navigator.serviceWorker?.controller !== null);
  await expect(status(creator)).toContainText("Connected", { timeout: 30_000 });
  await expect(status(joiner)).toContainText("Connected", { timeout: 30_000 });

  for (const peer of [creator, joiner]) {
    const turn = (await lastIce(peer))!.find((server) => [server.urls].flat().includes("turn:127.0.0.1:3481"));
    expect(turn, `${peer.kind} got the server's TURN entry`).toBeDefined();
    // coturn's shared-secret scheme: the username is the expiry time in unix seconds.
    expect(turn!.username).toMatch(/^\d+$/);
    expect(Number(turn!.username)).toBeGreaterThan(Date.now() / 1000);
  }
  await transfer(creator, joiner, "through-server-turn.bin", SMALL);
  expect(await selectedLocalType(creator)).toBe("relay");
  expect(await selectedLocalType(joiner)).toBe("relay");
});

test("credentials signed with a secret coturn does not share never connect, and the page says the relay is unreachable", async () => {
  const creator = await launch("chromium");
  const joiner = await launch("firefox");

  const seen: string[] = [];
  await relayedRoom(creator, joiner, WRONG_SECRET_URL);
  // Whichever side gives up first ends the room, so the other may only see that the peer left.
  await expect
    .poll(
      async () => {
        for (const peer of [creator, joiner]) seen.push(await status(peer).innerText());

        return seen.some((text) => text.includes("Could not reach our relay server"));
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(seen.filter((text) => text.includes("Connected"))).toEqual([]);
});
