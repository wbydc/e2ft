// Shared e2e fixtures: separate browser profiles (Chromium, Firefox) talk through the real server.
// E2E_SIZE_MB sets the main transferred file size (default 64; acceptance runs use 2048 and 5120).
import { test, expect, chromium, firefox } from "@playwright/test";
import type { BrowserContext, Download, Page, WebSocketRoute } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/config.ts";

export const SIZE = Number(process.env.E2E_SIZE_MB ?? 64) * 1024 * 1024 + 12_345;

export const BASE = `http://127.0.0.1:${process.env.E2E_PORT ?? 18080}`;

export const CANCEL_SIZE = 512 * 1024 * 1024;

export const SMALL = 1_000_000;

/** The server and the bundle were built with these: the same env reaches `cargo run` and the build. */
const ACCESS_LEN = Number(process.env.ACCESS_LEN || DEFAULTS.ACCESS_LEN);
const FRAGMENT_LEN = 2 + Number(process.env.SECRET_LEN || DEFAULTS.SECRET_LEN);
const CROCKFORD = "[0-9A-HJKMNP-TV-Z]";

export interface Peer {
  kind: "chromium" | "firefox" | "iphone";
  ctx: BrowserContext;
  page: Page;
  dir: string;
  /** The page's peer connection events and errors, printed when a test fails. */
  log: string[];
}

const peers: Peer[] = [];

export let tempDirectory: string;

/** `camera`: a touch device whose camera shows this .y4m file; `allow: false` refuses camera access. */
export type CameraOpt = { file: string; allow: boolean };

export async function launch(
  kind: Peer["kind"] = "chromium",
  opts: { serviceWorkers?: boolean; camera?: CameraOpt; reducedMotion?: "reduce" } = {},
): Promise<Peer> {
  const dir = await mkdtemp(join(tmpdir(), "e2ft-e2e-profile-"));
  let context: BrowserContext;
  if (kind === "iphone") {
    // Chromium posing as iOS Safari: iPhone user agent and no save picker, so the page takes the iOS hold path.
    context = await chromium.launchPersistentContext(dir, {
      baseURL: BASE,
      acceptDownloads: true,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
      reducedMotion: opts.reducedMotion,
    });
    await context.addInitScript(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined }));
  } else if (kind === "chromium") {
    const camera = opts.camera;
    context = await chromium.launchPersistentContext(dir, {
      baseURL: BASE,
      // The default headless shell has no video capture; full Chromium in headless mode does.
      channel: camera ? "chromium" : undefined,
      // Raw host candidates instead of mDNS names, so two headless processes on one host can connect.
      args: [
        "--disable-features=WebRtcHideLocalIpsWithMdns",
        ...(camera ? ["--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${camera.file}`] : []),
      ],
      hasTouch: !!camera,
      permissions: camera?.allow ? ["camera"] : [],
      reducedMotion: opts.reducedMotion,
    });
    // Headless Chromium cannot show the save picker: save into the origin private file system instead.
    await context.addInitScript(() => {
      (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (o: {
        suggestedName: string;
      }) => (await navigator.storage.getDirectory()).getFileHandle(o.suggestedName, { create: true });
    });
  } else {
    context = await firefox.launchPersistentContext(dir, {
      baseURL: BASE,
      acceptDownloads: true,
      firefoxUserPrefs: {
        "media.peerconnection.ice.obfuscate_host_addresses": false,
        // The test coturn listens on 127.0.0.1 only; Firefox skips loopback ICE by default.
        "media.peerconnection.ice.loopback": true,
        "dom.serviceWorkers.enabled": opts.serviceWorkers ?? true,
      },
    });
  }
  await context.addInitScript(logPeerConnections);
  const page = context.pages()[0] ?? (await context.newPage());
  const peer: Peer = { kind, ctx: context, page, dir, log: [] };
  page.on("console", (message) => {
    if (message.text().startsWith("[rtc]") || message.type() === "error") peer.log.push(message.text());
  });
  page.on("pageerror", (err) => peer.log.push(`[pageerror] ${err.message}`));
  peers.push(peer);

  return peer;
}

/** Runs in the page: logs every peer connection's candidates, state changes and failed calls as "[rtc] ..." lines. */
function logPeerConnections() {
  const started = performance.now();
  let count = 0;
  const say = (id: number, text: string) =>
    console.debug(`[rtc] ${((performance.now() - started) / 1000).toFixed(2)}s pc${id} ${text}`);
  const ids = new WeakMap<RTCPeerConnection, number>();
  const idOf = (connection: RTCPeerConnection) => {
    if (!ids.has(connection)) {
      const id = ++count;
      ids.set(connection, id);
      say(id, `new ${JSON.stringify(connection.getConfiguration().iceServers)}`);
      connection.addEventListener("icecandidate", (event) => say(id, `local ${event.candidate?.candidate ?? "end"}`));
      for (const kind of ["connectionstatechange", "iceconnectionstatechange", "icegatheringstatechange"]) {
        connection.addEventListener(kind, () =>
          say(
            id,
            `${kind} ${connection.connectionState}/${connection.iceConnectionState}/${connection.iceGatheringState}`,
          ),
        );
      }
    }

    return ids.get(connection)!;
  };
  const proto = RTCPeerConnection.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of [
    "setLocalDescription",
    "setRemoteDescription",
    "addIceCandidate",
    "createOffer",
    "createAnswer",
  ]) {
    const original = proto[method];
    proto[method] = function (this: RTCPeerConnection, ...args: unknown[]) {
      const id = idOf(this);
      const arg = args[0] as { candidate?: string; type?: string } | undefined;
      say(id, `${method} ${arg?.candidate ?? arg?.type ?? ""}`);

      return original.apply(this, args).catch((err: Error) => {
        say(id, `${method} rejected: ${err.name}: ${err.message}`);
        throw err;
      });
    };
  }
}

export const status = (p: Peer) => p.page.locator("#status");

export async function createRoom(creator: Peer): Promise<string> {
  await creator.page.goto("/");
  await creator.page.click("#create");
  await expect(status(creator)).toContainText("Room ready");
  await expect(creator.page.locator("#drop")).toBeHidden();
  const invite = await creator.page.inputValue("#invite");
  expect(invite).toMatch(new RegExp(`/r/${CROCKFORD}{${ACCESS_LEN}}#${CROCKFORD}{${FRAGMENT_LEN}}$`));
  await expect(creator.page.locator("#show-access")).toHaveValue(new RegExp(`^${CROCKFORD}{${ACCESS_LEN}}$`));

  return invite;
}

/** Opens an invite and confirms on the Join screen, as a joiner does. */
export async function joinFromInvite(joiner: Peer, invite: string, shared?: "theirs" | "mine" | "ours") {
  await joiner.page.goto(invite);
  const dialog = joiner.page.locator("#settings");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#settings-title")).toHaveText("Join room");
  if (shared) await dialog.locator("#set-shared").selectOption(shared);
  await dialog.locator("#set-submit").click();
  await expect(dialog).toBeHidden();
}

export async function connectedPair(joiner?: Peer): Promise<{ a: Peer; b: Peer; invite: string }> {
  const creator = await launch();
  joiner ??= await launch();
  const invite = await createRoom(creator);
  await joinFromInvite(joiner, invite);
  if (joiner.kind === "firefox") await joiner.page.waitForFunction(() => navigator.serviceWorker?.controller !== null);
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");
  await expect(creator.page.locator("#drop")).toBeVisible();

  return { a: creator, b: joiner, invite };
}

export async function makeFile(name: string, size: number): Promise<{ path: string; sha: string }> {
  const path = join(tempDirectory, name);
  const out = createWriteStream(path);
  const hash = createHash("sha256");
  for (let left = size; left > 0;) {
    const block = randomBytes(Math.min(left, 8 << 20));
    hash.update(block);
    left -= block.length;
    if (!out.write(block)) await new Promise<void>((r) => out.once("drain", () => r()));
  }
  await new Promise<void>((r) => out.end(() => r()));

  return { path, sha: hash.digest("hex") };
}

export async function savedSha(peer: Peer, name: string): Promise<{ size: number; sha: string }> {
  const size = await peer.page.evaluate(async (fileName) => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle(fileName)).getFile();

    return file.size;
  }, name);
  const hash = createHash("sha256");
  const SLICE = 16 << 20;
  for (let offset = 0; offset < size; offset += SLICE) {
    const base64 = await peer.page.evaluate(
      async ([fileName, from, to]) => {
        const file = await (await (await navigator.storage.getDirectory()).getFileHandle(fileName as string)).getFile();
        const bytes = new Uint8Array(await file.slice(from as number, to as number).arrayBuffer());

        return (bytes as unknown as { toBase64(): string }).toBase64();
      },
      [name, offset, offset + SLICE],
    );
    hash.update(Buffer.from(base64, "base64"));
  }

  return { size, sha: hash.digest("hex") };
}

export async function fileSha(path: string): Promise<{ size: number; sha: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }

  return { size, sha: hash.digest("hex") };
}

/** Offers a file and accepts it; resolves with the receiver's download when it saves through one. */
export async function offerAndAccept(from: Peer, to: Peer, name: string, size: number, domClick = false) {
  const file = await makeFile(name, size);
  await from.page.setInputFiles("#file", file.path);
  await expect(to.page.locator("#offer-name")).toHaveText(name);
  const download = to.kind === "firefox" ? to.page.waitForEvent("download", { timeout: 0 }) : null;
  if (domClick) await to.page.locator("#offer-accept").dispatchEvent("click");
  else await to.page.click("#offer-accept");

  return { file, download };
}

export async function transfer(from: Peer, to: Peer, name: string, size = SIZE, domClick = false) {
  const { file, download } = await offerAndAccept(from, to, name, size, domClick);
  const big = { timeout: Math.max(60_000, size / 5_000) };
  await expect(to.page.locator("#status")).toContainText(`Saved ${name}`, big);
  await expect(from.page.locator("#status")).toContainText("was saved by the other person", big);
  const saved = download ? await downloaded(await download) : await savedSha(to, name);
  expect(saved).toEqual({ size, sha: file.sha });
}

export async function downloaded(download: Download): Promise<{ size: number; sha: string }> {
  return fileSha(await download.path());
}

export const hasFile = (p: Peer, name: string) =>
  p.page.evaluate(async (fileName) => {
    try {
      await (await navigator.storage.getDirectory()).getFileHandle(fileName);

      return true;
    } catch {
      return false;
    }
  }, name);

/** Starts a big transfer and waits until both progress rows show movement and a rate. */
export async function midTransfer(creator: Peer, joiner: Peer, name: string) {
  const started = await offerAndAccept(creator, joiner, name, CANCEL_SIZE);
  for (const [peer, dir] of [
    [creator, "out"],
    [joiner, "in"],
  ] as const) {
    // The first bytes wait for the receiver's save target to open, which can take seconds on a cold profile.
    await expect
      .poll(() => peer.page.locator(`#${dir}-bar`).evaluate((e) => (e as HTMLProgressElement).value), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await expect(peer.page.locator(`#${dir}-text`)).toContainText("/s");
  }

  return started;
}

/** Records every frame the server relays to and from this page. */
export async function recordRelayFrames(peer: Peer): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  await peer.page.routeWebSocket(/\/ws$/, (socket: WebSocketRoute) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      frames.push(Buffer.from(message));
      server.send(message);
    });
    server.onMessage((message) => {
      frames.push(Buffer.from(message));
      socket.send(message);
    });
  });

  return frames;
}

/** Keeps every RTCPeerConnection the page makes in window.pcs. */
export async function recordPeerConnections(peer: Peer) {
  await peer.ctx.addInitScript(() => {
    const Original = RTCPeerConnection;
    const pageWindow = window as unknown as { RTCPeerConnection: unknown; pcs: RTCPeerConnection[] };
    pageWindow.pcs = [];
    pageWindow.RTCPeerConnection = class extends Original {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        pageWindow.pcs.push(this);
      }
    };
  });
}

export const OWN_TURN = { urls: "turn:127.0.0.1:3479", username: "e2e-turn-user", credential: "e2e-turn-cred-7Qx" };

export const JOINER_TURN = {
  urls: "turn:127.0.0.1:3480",
  username: "e2e-joiner-user",
  credential: "e2e-joiner-cred-9Lp",
};

export const asIce = (t: typeof OWN_TURN) => [{ urls: [t.urls], username: t.username, credential: t.credential }];

export const lastIce = (p: Peer) =>
  p.page.evaluate(() => (window as unknown as { pcs: RTCPeerConnection[] }).pcs.at(-1)!.getConfiguration().iceServers);

/** Saves settings into a peer's localStorage before it opens a room. */
export async function presetSettings(
  peer: Peer,
  turn: typeof OWN_TURN | null,
  shareTurn = false,
  alwaysTurn = false,
  keepAlive = 300,
) {
  await peer.page.goto("/");
  const settingsJson = JSON.stringify({
    keepAlive,
    turn: turn && { ...turn, urls: [turn.urls] },
    shareTurn,
    alwaysTurn,
  });
  await peer.page.evaluate((v) => localStorage.setItem("share-settings", v), settingsJson);
}

/** Counts how often the which-TURN prompt opens, in window.turnAsks. */
export async function countTurnAsks(peer: Peer) {
  await peer.ctx.addInitScript(() => {
    const pageWindow = window as unknown as { turnAsks: number };
    pageWindow.turnAsks = 0;
    const show = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      if (this.id === "turn-choice") pageWindow.turnAsks++;
      show.call(this);
    };
  });
}

export const lastPolicy = (p: Peer) =>
  p.page.evaluate(
    () => (window as unknown as { pcs: RTCPeerConnection[] }).pcs.at(-1)!.getConfiguration().iceTransportPolicy,
  );

/** Each spec calls this once: a temp folder for its files, and every launched browser closed after each test. */
export function registerHooks() {
  test.beforeAll(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "e2ft-e2e-files-"));
  });
  test.afterAll(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  test.afterEach(async () => {
    const testInfo = test.info();
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const [i, peer] of peers.entries()) console.log(`--- peer ${i} (${peer.kind})\n${peer.log.join("\n")}`);
    }
    for (const peer of peers.splice(0)) {
      await peer.ctx.close().catch(() => {});
      await rm(peer.dir, { recursive: true, force: true });
    }
  });
}
