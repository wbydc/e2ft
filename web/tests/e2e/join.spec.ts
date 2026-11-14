import { test, expect } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";
import {
  BASE,
  JOINER_TURN,
  OWN_TURN,
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

test("an invite opens the Join screen and nothing reaches /ws before Join", async () => {
  const creator = await launch();
  const joiner = await launch();
  const invite = await createRoom(creator);
  const sockets: string[] = [];
  joiner.page.on("websocket", (ws) => sockets.push(ws.url()));
  await joiner.page.goto(invite);
  const dialog = joiner.page.locator("#settings");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#settings-title")).toHaveText("Join room");
  await expect(dialog.locator("#set-submit")).toHaveText("Join");
  // The checkbox is per-room here, unlike the saved "Always use TURN" in Settings.
  await expect(dialog.locator("#set-always-turn-label")).toHaveText("Use TURN");
  await expect(dialog.locator("#set-always-turn-hint")).toContainText("this room connects only through the relay");
  // The secret left the address bar before the dialog opened, and no socket exists yet.
  expect(joiner.page.url()).toBe(`${BASE}/`);
  expect(sockets).toEqual([]);
  await dialog.locator("#set-submit").click();
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");
  expect(sockets.some((u) => u.endsWith("/ws"))).toBe(true);
});

test("Cancel and Escape on the Join screen connect nothing and leave no secret in the URL", async () => {
  const creator = await launch();
  const invite = await createRoom(creator);
  for (const dismissal of ["Cancel", "Escape"] as const) {
    const joiner = await launch();
    const sockets: string[] = [];
    joiner.page.on("websocket", (ws) => sockets.push(ws.url()));
    await joiner.page.goto(invite);
    const dialog = joiner.page.locator("#settings");
    await expect(dialog).toBeVisible();
    if (dismissal === "Cancel") await dialog.getByRole("button", { name: "Cancel" }).click();
    else await joiner.page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(joiner.page.url()).toBe(`${BASE}/`);
    await expect(joiner.page.locator("#home")).toBeVisible();
    expect(sockets).toEqual([]);
    await expect(status(creator)).toContainText("Room ready");
  }
});

test("a default room's invite fragment is 00 plus its secret and its Join screen has no room block", async () => {
  const creator = await launch();
  const invite = await createRoom(creator);
  const fragment = new URL(invite).hash.slice(1);
  expect(fragment).toHaveLength(8);
  expect(fragment.startsWith("00")).toBe(true);
  // The creator sees exactly the fragment after the link's #; it is cleared once the peer joins.
  await expect(creator.page.locator("#show-secret")).toHaveValue(fragment);
  const joiner = await launch();
  await joiner.page.goto(invite);
  const dialog = joiner.page.locator("#settings");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#set-room")).toBeHidden();
  await expect(dialog.locator("#set-shared-field")).toBeHidden();
  await dialog.locator("#set-submit").click();
  await expect(status(joiner)).toContainText("Connected");
});

test("a custom room's Join screen lists exactly its non-default settings: 15 min and Relay over TCP", async () => {
  const creator = await launch();
  await creator.page.goto("/");
  await creator.page.getByRole("button", { name: "Create a Custom Room" }).click();
  await creator.page.locator("#set-keep").selectOption("900");
  await creator.page.locator("#set-conn").selectOption({ label: "Relay only, over TCP" });
  await creator.page.locator("#settings").getByRole("button", { name: "Create Room" }).click();
  await expect(status(creator)).toContainText("Room ready");
  const invite = await creator.page.inputValue("#invite");
  expect(new URL(invite).hash.slice(1)).toHaveLength(8);
  const joiner = await launch();
  await joiner.page.goto(invite);
  await expect(joiner.page.locator("#set-room")).toBeVisible();
  const lines = joiner.page.locator("#set-room-list li");
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toHaveText("If a side drops, the room waits 15 min.");
  await expect(lines.nth(1)).toHaveText("Relay only, over TCP.");
});

test("a shared TURN shows its line and the select on the Join screen, and the answer keeps #turn-choice closed", async () => {
  const creator = await launch();
  const joiner = await launch();
  await countTurnAsks(joiner);
  await presetSettings(creator, OWN_TURN, true);
  const invite = await createRoom(creator);
  await joiner.page.goto(invite);
  const dialog = joiner.page.locator("#settings");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#set-room-list li")).toHaveText("Shares its TURN server.");
  await expect(dialog.locator("#set-shared")).toBeVisible();
  // No own TURN: the choice is Theirs or Ours.
  await expect(dialog.locator("#set-shared-ours")).not.toHaveAttribute("hidden", "");
  await expect(dialog.locator("#set-shared-mine")).toHaveAttribute("hidden", "");
  await dialog.locator("#set-shared").selectOption("theirs");
  await dialog.locator("#set-submit").click();
  await expect(status(joiner)).toContainText("Connected");
  await expect(joiner.page.locator("#turn-choice")).toBeHidden();
  expect(await joiner.page.evaluate(() => (window as unknown as { turnAsks: number }).turnAsks)).toBe(0);
});

test("edits on the Join screen apply to that room only and leave the saved settings alone", async () => {
  const creator = await launch();
  const joiner = await launch();
  await presetSettings(creator, OWN_TURN, true);
  await recordPeerConnections(joiner);
  const invite = await createRoom(creator);
  await joiner.page.goto("/");
  const saved = await joiner.page.evaluate(() => localStorage.getItem("share-settings"));
  await joiner.page.goto(invite);
  const dialog = joiner.page.locator("#settings");
  await expect(dialog).toBeVisible();
  await dialog.locator("#set-relay").selectOption("own");
  await dialog.locator("#set-urls").fill(JOINER_TURN.urls);
  await dialog.locator("#set-user").fill(JOINER_TURN.username);
  await dialog.locator("#set-pass").fill(JOINER_TURN.credential);
  await dialog.locator("#set-always-turn").check();
  // Its own TURN now exists, so the shared-TURN choice offers Use Mine.
  await expect(dialog.locator("#set-shared-mine")).not.toHaveAttribute("hidden", "");
  await dialog.locator("#set-shared").selectOption("mine");
  await dialog.locator("#set-submit").click();
  await expect(dialog).toBeHidden();
  // The room uses the edited TURN only, relay-only from Always use TURN.
  await expect
    .poll(() => joiner.page.evaluate(() => (window as unknown as { pcs: RTCPeerConnection[] }).pcs.length))
    .toBeGreaterThan(0);
  expect(await lastIce(joiner)).toEqual(asIce(JOINER_TURN));
  expect(await lastPolicy(joiner)).toBe("relay");
  expect(await joiner.page.evaluate(() => localStorage.getItem("share-settings"))).toBe(saved);
});

test("typed keys of a default room join with no room block", async () => {
  const creator = await launch();
  const invite = await createRoom(creator);
  const url = new URL(invite);
  const accessKey = url.pathname.split("/").pop()!;
  const fragment = url.hash.slice(1);
  const joiner = await launch();
  await joiner.page.goto("/");
  // A too-long access key is refused before anything reaches the server.
  await joiner.page.fill("#access", accessKey + "A".repeat(14));
  await joiner.page.fill("#secret", fragment);
  await joiner.page.locator("#join").getByRole("button", { name: "Join Room" }).click();
  await expect(joiner.page.locator("#join-error")).toContainText("The access key is 8 letters");
  // Typed in lower case, as on a phone keyboard: the keys are case-insensitive.
  await joiner.page.fill("#access", accessKey.toLowerCase());
  await joiner.page.fill("#secret", fragment.toLowerCase());
  await joiner.page.locator("#join").getByRole("button", { name: "Join Room" }).click();
  const dialog = joiner.page.locator("#settings");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#set-room")).toBeHidden();
  await dialog.locator("#set-submit").click();
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");
});

test("typed keys carry the creator's room settings to the Join screen", async () => {
  const creator = await launch();
  await creator.page.goto("/");
  await creator.page.getByRole("button", { name: "Create a Custom Room" }).click();
  await creator.page.locator("#set-keep").selectOption("900");
  await creator.page.locator("#settings").getByRole("button", { name: "Create Room" }).click();
  await expect(status(creator)).toContainText("Room ready");
  const invite = await creator.page.inputValue("#invite");
  const fragment = new URL(invite).hash.slice(1);
  // The creator's Secret Key field is exactly the link fragment; read it before the joiner's arrival clears it.
  await expect(creator.page.locator("#show-secret")).toHaveValue(fragment);
  const url = new URL(invite);
  const accessKey = url.pathname.split("/").pop()!;
  const joiner = await launch();
  await joiner.page.goto("/");
  await joiner.page.fill("#access", accessKey);
  await joiner.page.fill("#secret", fragment);
  await joiner.page.locator("#join").getByRole("button", { name: "Join Room" }).click();
  const dialog = joiner.page.locator("#settings");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#set-room")).toBeVisible();
  await expect(dialog.locator("#set-room")).toHaveClass(/ui-alert/);
  await expect(dialog.locator("#set-room-lead")).toBeVisible();
  const lines = dialog.locator("#set-room-list li");
  await expect(lines).toHaveCount(1);
  await expect(lines.nth(0)).toHaveText("If a side drops, the room waits 15 min.");
  await dialog.locator("#set-submit").click();
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");
});

test("a link with unreadable config chars still joins with unknown settings, and the fallback TURN prompt still asks", async () => {
  const creator = await launch();
  const joiner = await launch();
  await countTurnAsks(joiner);
  await presetSettings(creator, OWN_TURN, true);
  // An own TURN on the joiner is where the turn-choice dialog asks rather than using the shared one silently.
  await presetSettings(joiner, JOINER_TURN);
  const invite = await createRoom(creator);
  const url = new URL(invite);
  // Connection index 3 ("0R") leaves the secret intact; the hints are unknown and the sealed turn frame decides.
  await joiner.page.goto(`${url.origin}${url.pathname}#0R${url.hash.slice(3)}`);
  const dialog = joiner.page.locator("#settings");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#set-room")).toBeVisible();
  await expect(dialog.locator("#set-room-lead")).toBeHidden();
  await expect(dialog.locator("#set-room-list li")).toHaveText("The room's settings are unknown.");
  await expect(dialog.locator("#set-shared-field")).toBeHidden();
  await dialog.locator("#set-submit").click();
  const turnPrompt = joiner.page.locator("#turn-choice");
  await expect(turnPrompt).toBeVisible();
  await turnPrompt.getByRole("button", { name: "Use Theirs" }).click();
  await expect(status(joiner)).toContainText("Connected");
});

test("a wrong secret ends the room on both sides after the key exchange, before any sealed message", async () => {
  const creator = await launch();
  const joiner = await launch();
  const binary: number[] = [];
  await creator.page.routeWebSocket(/\/ws$/, (socket: WebSocketRoute) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (typeof message !== "string") binary.push(message.length);
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message !== "string") binary.push(message.length);
      socket.send(message);
    });
  });
  const invite = await createRoom(creator);
  const url = new URL(invite);
  const last = url.hash.slice(-1);
  await joinFromInvite(joiner, `${url.origin}${url.pathname}${url.hash.slice(0, -1)}${last === "0" ? "1" : "0"}`);
  for (const peer of [creator, joiner]) {
    await expect(status(peer)).toContainText("Wrong secret key");
    await expect(peer.page.locator("#restart")).toBeVisible();
    await expect(peer.page.locator("#drop")).toBeHidden();
  }
  // Two shares (gen + 32 bytes) and two tags (gen + 64 bytes); no sealed SDP ever went out.
  expect(binary.toSorted((x, y) => x - y)).toEqual([36, 36, 68, 68]);
});

test("the relay tap holds no invite fragment, secret or TURN credential", async () => {
  const creator = await launch();
  const joiner = await launch();
  await presetSettings(creator, OWN_TURN, true);
  const frames = await recordRelayFrames(creator);
  const invite = await createRoom(creator);
  const fragment = new URL(invite).hash.slice(1);
  expect(fragment).toHaveLength(8);
  await joinFromInvite(joiner, invite);
  await expect(status(joiner)).toContainText("Connected");
  await transfer(creator, joiner, "tap.bin", SMALL);
  const relayed = Buffer.concat(frames).toString("latin1");
  expect(frames.length).toBeGreaterThan(2);
  for (const leak of [fragment, fragment.slice(-6), OWN_TURN.username, OWN_TURN.credential, "127.0.0.1:3479"])
    expect(relayed).not.toContain(leak);
});
