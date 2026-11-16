import { test, expect } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";
import {
  JOINER_TURN,
  OWN_TURN,
  Peer,
  SMALL,
  asIce,
  countTurnAsks,
  createRoom,
  joinFromInvite,
  lastIce,
  lastPolicy,
  launch,
  presetSettings,
  recordPeerConnections,
  recordRelayFrames,
  registerHooks,
  status,
  transfer,
} from "./fixtures.ts";

registerHooks();

/** Needs the local coturns: CI runs these, and only these, in the job that starts them (`--grep @turn`). */
const TURN = { tag: "@turn" };

/** Fills the open settings dialog. */
async function fillSettings(peer: Peer, keep: string, turn: typeof OWN_TURN | null) {
  const dialog = peer.page.locator("#settings");
  await dialog.locator("#set-keep").selectOption(keep);
  await dialog.locator("#set-relay").selectOption(turn ? "own" : "ours");
  if (turn) {
    await dialog.locator("#set-urls").fill(turn.urls);
    await dialog.locator("#set-user").fill(turn.username);
    await dialog.locator("#set-pass").fill(turn.credential);
  }
}

test("saved settings survive a reload and go into Create Room; an own TURN server replaces ours and never reaches the server", async () => {
  const creator = await launch();
  const joiner = await launch();
  await recordPeerConnections(creator);
  const frames = await recordRelayFrames(creator);
  await creator.page.goto("/");

  await creator.page.getByRole("button", { name: "Settings" }).click();
  await fillSettings(creator, "900", { ...OWN_TURN, urls: "stun:nope" });
  await creator.page.locator("#set-submit").click();
  await expect(creator.page.locator("#set-error")).toContainText("turn: or turns:");
  await fillSettings(creator, "900", OWN_TURN);
  await creator.page.locator("#set-submit").click();
  await expect(creator.page.locator("#settings")).toBeHidden();

  await creator.page.reload();
  await creator.page.getByRole("button", { name: "Settings" }).click();
  await expect(creator.page.locator("#set-keep")).toHaveValue("900");
  await expect(creator.page.locator("#set-relay")).toHaveValue("own");
  await expect(creator.page.locator("#set-urls")).toHaveValue(OWN_TURN.urls);
  await expect(creator.page.locator("#set-pass")).toHaveValue(OWN_TURN.credential);
  await creator.page.getByRole("button", { name: "Cancel" }).click();

  const invite = await createRoom(creator);
  await expect(creator.page.locator("#room-info")).toHaveText(
    "If a side drops, the room waits 15 min. Relay: your TURN server.",
  );
  await joinFromInvite(joiner, invite);
  await expect(status(creator)).toContainText("Connected");
  await expect(joiner.page.locator("#room-info")).toHaveText(
    "If a side drops, the room waits 15 min. Relay: our servers.",
  );
  const config = await creator.page.evaluate(
    () => (window as unknown as { pcs: RTCPeerConnection[] }).pcs.at(-1)!.getConfiguration().iceServers,
  );
  expect(config).toEqual([{ urls: [OWN_TURN.urls], username: OWN_TURN.username, credential: OWN_TURN.credential }]);

  const relayed = Buffer.concat(frames).toString("latin1");
  for (const leak of [OWN_TURN.username, OWN_TURN.credential, "127.0.0.1:3479"]) expect(relayed).not.toContain(leak);
});

test("a custom room uses its own keep-alive and relay and leaves the saved defaults alone; Our servers clears the TURN entry", async () => {
  const creator = await launch();
  const joiner = await launch();
  await creator.page.goto("/");
  await creator.page.getByRole("button", { name: "Settings" }).click();
  await fillSettings(creator, "900", OWN_TURN);
  await creator.page.locator("#set-submit").click();
  const saved = await creator.page.evaluate(() => localStorage.getItem("share-settings"));

  await creator.page.getByRole("button", { name: "Create a Custom Room" }).click();
  await expect(creator.page.locator("#settings-title")).toHaveText("Custom Room");
  await expect(creator.page.locator("#set-keep")).toHaveValue("900");
  await fillSettings(creator, "60", null);
  await creator.page.locator("#settings").getByRole("button", { name: "Create Room" }).click();
  await expect(status(creator)).toContainText("Room ready");
  await expect(creator.page.locator("#room-info")).toHaveText(
    "If a side drops, the room waits 1 min. Relay: our servers.",
  );
  expect(await creator.page.evaluate(() => localStorage.getItem("share-settings"))).toBe(saved);

  await joinFromInvite(joiner, await creator.page.inputValue("#invite"));
  await expect(status(joiner)).toContainText("Connected");
  await expect(joiner.page.locator("#room-info")).toHaveText(
    "If a side drops, the room waits 1 min. Relay: our servers.",
  );
  await joiner.page.close();

  const third = await launch();
  await third.page.goto("/");
  await third.page.getByRole("button", { name: "Settings" }).click();
  await fillSettings(third, "0", OWN_TURN);
  await third.page.locator("#set-submit").click();
  await third.page.getByRole("button", { name: "Settings" }).click();
  await fillSettings(third, "0", null);
  await third.page.locator("#set-submit").click();
  await third.page.reload();
  await third.page.getByRole("button", { name: "Settings" }).click();
  await expect(third.page.locator("#set-relay")).toHaveValue("ours");
  await expect(third.page.locator("#set-urls")).toHaveValue("");
  await expect(third.page.locator("#set-keep")).toHaveValue("0");
  await third.page.getByRole("button", { name: "Cancel" }).click();
  await createRoom(third);
  await expect(third.page.locator("#room-info")).toHaveText(
    "The room ends as soon as a side drops. Relay: our servers.",
  );
});

test("?relay=1 with an own TURN server relays through it (needs E2E_TURN=1 and a local coturn)", TURN, async () => {
  test.skip(!process.env.E2E_TURN, "no local coturn");
  const creator = await launch();
  const joiner = await launch();
  await recordPeerConnections(creator);
  const settings = JSON.stringify({ keepAlive: 300, turn: { ...OWN_TURN, urls: [OWN_TURN.urls] } });
  for (const peer of [creator, joiner]) {
    await peer.page.goto("/");
    await peer.page.evaluate((s) => localStorage.setItem("share-settings", s), settings);
  }
  await creator.page.goto("/?relay=1");
  await creator.page.click("#create");
  await expect(status(creator)).toContainText("Room ready");
  await joinFromInvite(joiner, await creator.page.inputValue("#invite"));
  await expect(status(creator)).toContainText("Connected", { timeout: 20_000 });
  await transfer(creator, joiner, "via-own-turn.bin", SMALL);
  const local = await creator.page.evaluate(async () => {
    const stats = await (window as unknown as { pcs: RTCPeerConnection[] }).pcs.at(-1)!.getStats();
    const pair = [...stats.values()].find((r) => r.type === "candidate-pair" && r.nominated && r.state === "succeeded");
    const candidate = stats.get(pair.localCandidateId);

    return { type: candidate.candidateType, port: candidate.port };
  });
  expect(local.type).toBe("relay");
  expect(local.port).toBeGreaterThanOrEqual(49160);
  await creator.page.getByRole("button", { name: "Connection Info" }).click();
  await expect(creator.page.locator("#conn-path")).toHaveText(/^Through the TURN relay/);
});

test("sharing an own TURN server: the box is off by default and persists, the joiner relays only through it, and the relay never sees it", async () => {
  const creator = await launch();
  const joiner = await launch();
  await recordPeerConnections(joiner);
  const frames = await recordRelayFrames(creator);
  await creator.page.goto("/");
  await creator.page.getByRole("button", { name: "Settings" }).click();
  await fillSettings(creator, "300", OWN_TURN);
  await expect(creator.page.locator("#set-share")).not.toBeChecked();
  await creator.page.getByLabel("Share my TURN server with the other person").check();
  await creator.page.locator("#set-submit").click();
  await creator.page.reload();
  await creator.page.getByRole("button", { name: "Settings" }).click();
  await expect(creator.page.locator("#set-share")).toBeChecked();
  await creator.page.getByRole("button", { name: "Cancel" }).click();

  const invite = await createRoom(creator);
  await joinFromInvite(joiner, invite, "theirs");
  await expect(status(joiner)).toContainText("Connected");
  expect(await lastIce(joiner)).toEqual(asIce(OWN_TURN));
  await expect(joiner.page.locator("#room-info")).toHaveText(
    "If a side drops, the room waits 5 min. Relay: their TURN server.",
  );
  await expect(joiner.page.locator("#turn-choice")).toBeHidden();
  await expect(joiner.page.locator("body")).not.toContainText(OWN_TURN.username);
  await transfer(creator, joiner, "via-shared.bin", SMALL);

  const relayed = Buffer.concat(frames).toString("latin1");
  expect(frames.length).toBeGreaterThan(2);
  for (const leak of [OWN_TURN.username, OWN_TURN.credential, "127.0.0.1:3479"]) expect(relayed).not.toContain(leak);
});

test("a custom room can turn sharing off without changing the saved defaults; with sharing off the joiner keeps its config", async () => {
  const creator = await launch();
  const joiner = await launch();
  await recordPeerConnections(joiner);
  await presetSettings(creator, OWN_TURN, true);
  await creator.page.goto("/");
  const saved = await creator.page.evaluate(() => localStorage.getItem("share-settings"));
  await creator.page.getByRole("button", { name: "Create a Custom Room" }).click();
  await expect(creator.page.locator("#set-share")).toBeChecked();
  await creator.page.locator("#set-share").uncheck();
  await creator.page.locator("#settings").getByRole("button", { name: "Create Room" }).click();
  await expect(status(creator)).toContainText("Room ready");
  expect(await creator.page.evaluate(() => localStorage.getItem("share-settings"))).toBe(saved);

  await joinFromInvite(joiner, await creator.page.inputValue("#invite"));
  await expect(status(joiner)).toContainText("Connected");
  const iceServers = JSON.stringify(await lastIce(joiner));
  expect(iceServers).not.toContain(OWN_TURN.username);
  await expect(joiner.page.locator("#room-info")).toHaveText(
    "If a side drops, the room waits 5 min. Relay: our servers.",
  );
});

for (const answer of ["Use Theirs", "Use Mine"] as const) {
  test(`a joiner with its own TURN server picks ${answer} on the Join screen; that config holds after a reconnect`, async () => {
    const creator = await launch();
    const joiner = await launch();
    await recordPeerConnections(joiner);
    await countTurnAsks(joiner);
    await presetSettings(creator, OWN_TURN, true);
    await presetSettings(joiner, JOINER_TURN);
    let live: WebSocketRoute | null = null;
    let blocked = false;
    await joiner.page.routeWebSocket(/\/ws$/, (socket: WebSocketRoute) => {
      if (blocked) return void socket.close();
      socket.connectToServer();
      live = socket;
    });
    const invite = await createRoom(creator);
    await joinFromInvite(joiner, invite, answer === "Use Theirs" ? "theirs" : "mine");
    await expect(joiner.page.locator("#turn-choice")).toBeHidden();
    await expect(status(joiner)).toContainText("Connected");
    const theirs = answer === "Use Theirs";
    const info = `If a side drops, the room waits 5 min. Relay: ${theirs ? "their" : "your"} TURN server.`;
    expect(await lastIce(joiner)).toEqual(asIce(theirs ? OWN_TURN : JOINER_TURN));
    await expect(joiner.page.locator("#room-info")).toHaveText(info);

    const before = await joiner.page.evaluate(() => (window as unknown as { pcs: RTCPeerConnection[] }).pcs.length);
    blocked = true;
    await joiner.page.evaluate(() =>
      (window as unknown as { pcs: RTCPeerConnection[] }).pcs.forEach((pc) => pc.close()),
    );
    await live!.close();
    await expect(status(joiner)).toContainText("Reconnecting");
    blocked = false;
    await expect(status(joiner)).toContainText("Connected", { timeout: 20_000 });
    expect(
      await joiner.page.evaluate(() => (window as unknown as { pcs: RTCPeerConnection[] }).pcs.length),
    ).toBeGreaterThan(before);
    expect(await lastIce(joiner)).toEqual(asIce(theirs ? OWN_TURN : JOINER_TURN));
    await expect(joiner.page.locator("#room-info")).toHaveText(info);
    expect(await joiner.page.evaluate(() => (window as unknown as { turnAsks: number }).turnAsks)).toBe(0);
  });
}

test(
  "?relay=1 on the joiner relays through the creator's shared TURN server (needs E2E_TURN=1 and a local coturn)",
  TURN,
  async () => {
    test.skip(!process.env.E2E_TURN, "no local coturn");
    const creator = await launch();
    const joiner = await launch();
    await recordPeerConnections(joiner);
    await presetSettings(creator, OWN_TURN, true);
    const invite = await createRoom(creator);
    const url = new URL(invite);
    await joinFromInvite(joiner, `${url.pathname}?relay=1${url.hash}`, "theirs");
    await expect(status(joiner)).toContainText("Connected", { timeout: 20_000 });
    await transfer(creator, joiner, "via-shared-turn.bin", SMALL);
    expect(await lastIce(joiner)).toEqual(asIce(OWN_TURN));
    expect((await nominatedLocal(joiner)).type).toBe("relay");
  },
);

/** The local candidate of the pair the connection nominated. */
const nominatedLocal = (p: Peer) =>
  p.page.evaluate(async () => {
    const stats = await (window as unknown as { pcs: RTCPeerConnection[] }).pcs.at(-1)!.getStats();
    const pair = [...stats.values()].find((r) => r.type === "candidate-pair" && r.nominated && r.state === "succeeded");
    const local = stats.get(pair.localCandidateId);

    return { type: local.candidateType as string, port: local.port as number };
  });

/** Waits until the joiner has applied the offer, so its config is final. */
const offerApplied = (p: Peer) =>
  p.page.waitForFunction(() => !!(window as unknown as { pcs: RTCPeerConnection[] }).pcs.at(-1)?.remoteDescription);

for (const answer of ["Use Theirs", "Use Ours"] as const) {
  test(
    `in a Relay only room a joiner without its own TURN answers ${answer} on the Join screen; ${answer} relays through that server (theirs needs E2E_TURN=1)`,
    answer === "Use Theirs" ? TURN : {},
    async () => {
      const theirs = answer === "Use Theirs";
      test.skip(theirs && !process.env.E2E_TURN, "no local coturn");
      const creator = await launch();
      const joiner = await launch();
      await recordPeerConnections(joiner);
      await presetSettings(creator, OWN_TURN, true);
      await creator.page.goto("/");
      await joiner.page.goto(await customRoom(creator, "Relay only"));
      const dialog = joiner.page.locator("#settings");
      await expect(dialog).toBeVisible();
      // The creator's non-default settings ride in the invite, and the joiner picks the shared TURN here.
      await expect(dialog.locator("#set-room-list")).toContainText("Relay only.");
      await expect(dialog.locator("#set-room-list")).toContainText("Shares its TURN server.");
      await expect(dialog.locator("#set-shared-field")).toContainText("that server will see your IP address");
      await expect(dialog.locator("#set-shared-mine")).toHaveAttribute("hidden", "");
      await dialog.locator("#set-shared").selectOption(theirs ? "theirs" : "ours");
      await dialog.locator("#set-submit").click();
      await expect(joiner.page.locator("#turn-choice")).toBeHidden();
      await offerApplied(joiner);
      expect(await lastPolicy(joiner)).toBe("relay");
      if (theirs) {
        await expect(status(joiner)).toContainText("Connected", { timeout: 20_000 });
        expect(await lastIce(joiner)).toEqual(asIce(OWN_TURN));
        await expect(joiner.page.locator("#room-info")).toHaveText(
          "If a side drops, the room waits 5 min. Relay: their TURN server. Relay only.",
        );
        // The e2e coturn on 3479 hands out relay ports 49160-49200.
        const local = await nominatedLocal(joiner);
        expect(local.type).toBe("relay");
        expect(local.port).toBeGreaterThanOrEqual(49160);
        expect(local.port).toBeLessThanOrEqual(49200);
      } else {
        // The e2e server has no TURN of its own, so ours is an empty list here and the room cannot connect.
        expect(await lastIce(joiner)).toEqual([]);
        await expect(joiner.page.locator("#room-info")).toHaveText(
          "If a side drops, the room waits 5 min. Relay: our servers. Relay only.",
        );
      }
    },
  );
}

test("a joiner with Always use TURN in an Auto room preselects Use Ours on the Join screen and the fallback never asks", async () => {
  const creator = await launch();
  const joiner = await launch();
  await recordPeerConnections(joiner);
  await countTurnAsks(joiner);
  await presetSettings(creator, OWN_TURN, true);
  await joiner.page.goto("/");
  await joiner.page.evaluate(() =>
    localStorage.setItem("share-settings", JSON.stringify({ keepAlive: 300, alwaysTurn: true })),
  );
  await joiner.page.goto(await createRoom(creator));
  const dialog = joiner.page.locator("#settings");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#set-shared")).toHaveValue("ours");
  await dialog.locator("#set-submit").click();
  await expect(joiner.page.locator("#turn-choice")).toBeHidden();
  await offerApplied(joiner);
  expect(await lastPolicy(joiner)).toBe("relay");
  expect(await lastIce(joiner)).toEqual([]);
  await expect(joiner.page.locator("#room-info")).toHaveText(
    "If a side drops, the room waits 5 min. Relay: our servers.",
  );
  expect(await joiner.page.evaluate(() => (window as unknown as { turnAsks: number }).turnAsks)).toBe(0);
});

/** Records every candidate line this page receives from its peer, from the remote SDP and from trickled candidates. */
async function recordRemoteCandidates(peer: Peer) {
  await peer.ctx.addInitScript(() => {
    const pageWindow = window as unknown as { remote: string[] };
    pageWindow.remote = [];
    const proto = RTCPeerConnection.prototype;
    const setRemote: (this: RTCPeerConnection, d: RTCSessionDescriptionInit) => Promise<void> =
      proto.setRemoteDescription;
    proto.setRemoteDescription = function (this: RTCPeerConnection, description: RTCSessionDescriptionInit) {
      pageWindow.remote.push(...(description?.sdp?.match(/a=candidate:.*/g) ?? []));

      return setRemote.call(this, description);
    };
    const add: (this: RTCPeerConnection, c?: RTCIceCandidateInit | null) => Promise<void> = proto.addIceCandidate;
    proto.addIceCandidate = function (this: RTCPeerConnection, candidate?: RTCIceCandidateInit | null) {
      if (candidate?.candidate) pageWindow.remote.push(candidate.candidate);

      return add.call(this, candidate);
    };
  });
}

const localTypes = (p: Peer) =>
  p.page.evaluate(async () => {
    const stats = await (window as unknown as { pcs: RTCPeerConnection[] }).pcs.at(-1)!.getStats();

    return [...stats.values()].filter((r) => r.type === "local-candidate").map((r) => r.candidateType as string);
  });

for (const toggled of ["chromium", "firefox"] as const) {
  test(
    `Always use TURN on a ${toggled} joiner alone: it gathers and sends only relay candidates, the creator in Auto is not told, a file arrives intact (needs E2E_TURN=1 and a local coturn)`,
    TURN,
    async () => {
      test.skip(!process.env.E2E_TURN, "no local coturn");
      const creator = await launch();
      const joiner = await launch(toggled);
      await recordPeerConnections(joiner);
      await recordRemoteCandidates(creator);
      // The creator needs a candidate the TURN server can reach: an mDNS host one is not (ours gives it srflx and relay in production).
      await presetSettings(creator, OWN_TURN);
      await joiner.page.goto("/");
      await joiner.page.evaluate(
        (v) => localStorage.setItem("share-settings", v),
        JSON.stringify({ keepAlive: 300, turn: { ...OWN_TURN, urls: [OWN_TURN.urls] }, alwaysTurn: true }),
      );
      const invite = await createRoom(creator);
      await joinFromInvite(joiner, invite);
      await expect(status(joiner)).toContainText("Connected", { timeout: 20_000 });
      await transfer(creator, joiner, "always-turn.bin", SMALL);
      await transfer(joiner, creator, "always-turn-back.bin", SMALL);
      expect(await lastPolicy(joiner)).toBe("relay");
      const types = await localTypes(joiner);
      expect(types.length).toBeGreaterThan(0);
      expect(new Set(types)).toEqual(new Set(["relay"]));
      const remote = await creator.page.evaluate(() => (window as unknown as { remote: string[] }).remote);
      expect(remote.length).toBeGreaterThan(0);
      for (const candidate of remote) expect(candidate).toMatch(/ typ relay/);
      expect(await creator.page.locator("#room-info").textContent()).not.toContain("Relay only");
      await creator.page.getByRole("button", { name: "Connection Info" }).click();
      await expect(creator.page.locator("#conn-detail")).toContainText("other side: relay");
    },
  );
}

test(
  "Always use TURN is saved, survives a reload, is hidden in the custom-room dialog, and still relays the creator in an Auto custom room (relay part needs E2E_TURN=1)",
  TURN,
  async () => {
    const creator = await launch();
    await recordPeerConnections(creator);
    await presetSettings(creator, process.env.E2E_TURN ? OWN_TURN : null);
    await creator.page.goto("/");
    await creator.page.getByRole("button", { name: "Settings" }).click();
    await expect(creator.page.locator("#set-always-turn")).not.toBeChecked();
    await expect(creator.page.locator("#set-always-turn-label")).toHaveText("Always use TURN");
    await expect(creator.page.locator("#set-always-turn-hint")).toContainText("Hides your IP from the other person");
    await creator.page.getByLabel("Always use TURN").check();
    await creator.page.locator("#set-submit").click();
    await creator.page.reload();
    await creator.page.getByRole("button", { name: "Settings" }).click();
    await expect(creator.page.locator("#set-always-turn")).toBeChecked();
    await creator.page.getByRole("button", { name: "Cancel" }).click();
    await creator.page.getByRole("button", { name: "Create a Custom Room" }).click();
    await expect(creator.page.locator("#set-always-turn-field")).toBeHidden();
    await creator.page.getByRole("button", { name: "Cancel" }).click();
    if (!process.env.E2E_TURN) return;
    const joiner = await launch("firefox");
    await recordRemoteCandidates(joiner);
    await joinFromInvite(joiner, await customRoom(creator, "Auto"));
    await expect(status(joiner)).toContainText("Connected", { timeout: 20_000 });
    await transfer(creator, joiner, "always-turn-custom.bin", SMALL);
    expect(await lastPolicy(creator)).toBe("relay");
    expect(new Set(await localTypes(creator))).toEqual(new Set(["relay"]));
    const remote = await joiner.page.evaluate(() => (window as unknown as { remote: string[] }).remote);
    for (const candidate of remote) expect(candidate).toMatch(/ typ relay/);
  },
);

for (const kind of ["chromium", "firefox"] as const) {
  test(`Always use TURN with a dead own TURN: a ${kind} creator ends at once with the relay-down text, not the ICE timeout`, async () => {
    test.skip(!!process.env.E2E_TURN, "the local coturn answers OWN_TURN, so it is not dead");
    const creator = await launch(kind);
    const joiner = await launch();
    await presetSettings(creator, OWN_TURN, false, true);
    const invite = await createRoom(creator);
    await joinFromInvite(joiner, invite);
    await expect(status(creator)).toContainText("Could not reach your TURN server", { timeout: 15_000 });
    await expect(status(creator)).not.toContainText("not even through the relay");
  });
}

/** Opens the custom-room dialog and picks a connection mode; the rest comes from the saved defaults. */
async function customRoom(creator: Peer, conn: "Auto" | "Relay only" | "Relay only, over TCP"): Promise<string> {
  await creator.page.getByRole("button", { name: "Create a Custom Room" }).click();
  await expect(creator.page.locator("#set-conn")).toHaveValue("auto");
  await creator.page.locator("#set-conn").selectOption({ label: conn });
  await creator.page.locator("#settings").getByRole("button", { name: "Create Room" }).click();
  await expect(status(creator)).toContainText("Room ready");

  return creator.page.inputValue("#invite");
}

test("the connection choice is only in the custom-room dialog and never saved; Auto connects as before, Relay over TCP switches the joiner", async () => {
  const creator = await launch();
  const joiner = await launch();
  const secondJoiner = await launch();
  for (const peer of [joiner, secondJoiner]) await recordPeerConnections(peer);
  await presetSettings(creator, null);
  await creator.page.goto("/");
  const saved = await creator.page.evaluate(() => localStorage.getItem("share-settings"));
  await creator.page.getByRole("button", { name: "Settings" }).click();
  await expect(creator.page.locator("#set-conn-field")).toBeHidden();
  await creator.page.getByRole("button", { name: "Cancel" }).click();

  await joinFromInvite(joiner, await customRoom(creator, "Auto"));
  await expect(status(joiner)).toContainText("Connected");
  expect(await lastPolicy(joiner)).toBe("all");
  await expect(joiner.page.locator("#room-info")).toHaveText(
    "If a side drops, the room waits 5 min. Relay: our servers.",
  );

  const secondCreator = await launch();
  await presetSettings(secondCreator, OWN_TURN, true);
  await secondCreator.page.goto("/");
  await joinFromInvite(secondJoiner, await customRoom(secondCreator, "Relay only, over TCP"), "theirs");
  await expect(secondJoiner.page.locator("#room-info")).toHaveText(
    "If a side drops, the room waits 5 min. Relay: their TURN server. Relay only, over TCP.",
  );
  await expect(secondCreator.page.locator("#room-info")).toHaveText(
    "If a side drops, the room waits 5 min. Relay: your TURN server. Relay only, over TCP.",
  );
  expect(await lastPolicy(secondJoiner)).toBe("relay");
  expect(await lastIce(secondJoiner)).toEqual([{ ...asIce(OWN_TURN)[0], urls: [OWN_TURN.urls + "?transport=tcp"] }]);
  for (const peer of [creator, secondCreator])
    expect(await peer.page.evaluate(() => localStorage.getItem("share-settings"))).not.toContain("tcp");
  expect(await creator.page.evaluate(() => localStorage.getItem("share-settings"))).toBe(saved);
});

for (const joinerKind of ["chromium", "firefox"] as const) {
  test(
    `a Relay over TCP room relays both browsers over TCP once a ${joinerKind} joiner picks the creator's TURN (needs E2E_TURN=1 and a local coturn)`,
    TURN,
    async () => {
      test.skip(!process.env.E2E_TURN, "no local coturn");
      const creator = await launch();
      const joiner = await launch(joinerKind);
      await presetSettings(creator, OWN_TURN, true);
      await creator.page.goto("/");
      const invite = await customRoom(creator, "Relay only, over TCP");
      expect(invite).not.toContain("relay");
      await joinFromInvite(joiner, invite, "theirs");
      if (joinerKind === "firefox")
        await joiner.page.waitForFunction(() => navigator.serviceWorker?.controller !== null);
      await expect(status(joiner)).toContainText("Connected", { timeout: 20_000 });
      await transfer(creator, joiner, "via-tcp-relay.bin", SMALL);
      for (const peer of [creator, joiner]) {
        await peer.page.getByRole("button", { name: "Connection Info" }).click();
        await expect(peer.page.locator("#conn-path")).toHaveText(/^Through the TURN relay/);
        await expect(peer.page.locator("#conn-detail")).toContainText("This side: relay, other side: relay, TCP");
      }
    },
  );
}
