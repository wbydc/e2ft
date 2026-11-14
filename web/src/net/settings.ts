// What a room is created with: an own TURN server, the keep-alive and whether the invite QR starts hidden. The saved defaults live in this browser
// only; Create Room copies them, a custom room uses its own copy. The TURN credential only
// ever goes into the RTCPeerConnection config, never to our server.
import { CONFIG } from "../config.ts";
import { load, save } from "../store.ts";

/** Off, 1, 5, 15 or 30 minutes, in seconds, unless the build sets another list. */
export const KEEP_ALIVES = CONFIG.KEEP_ALIVES;

export type Turn = { urls: string[]; username: string; credential: string };
/** `shareTurn`: send `turn` to the joiner, sealed, so it relays through it too. `alwaysTurn`: this browser
 * alone relays in every room, so the peer never learns its IP; the peer is not told. */
export type RoomSettings = {
  turn: Turn | null;
  /** Seconds, one of KEEP_ALIVES. */
  keepAlive: number;
  hideQr: boolean;
  shareTurn: boolean;
  alwaysTurn: boolean;
};

export const DEFAULTS: RoomSettings = {
  turn: null,
  keepAlive: CONFIG.KEEP_ALIVE,
  hideQr: false,
  shareTurn: false,
  alwaysTurn: false,
};

const TURN_URL = /^turns?:\S+$/;

// WebRTC refuses a turn: URL without a username and credential, so both are required.
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Saved data, form input and the peer's `turn` message are untrusted: an invalid TURN entry is null. */
export function parseTurn(raw: unknown): Turn | null {
  const turn = raw as Partial<Record<keyof Turn, unknown>> | null | undefined;

  return turn &&
    Array.isArray(turn.urls) &&
    turn.urls.length &&
    turn.urls.every((u) => isStr(u) && TURN_URL.test(u)) &&
    isStr(turn.username) &&
    isStr(turn.credential)
    ? { urls: turn.urls as string[], username: turn.username, credential: turn.credential }
    : null;
}

/** Anything that is not a valid setting falls back to its default. */
export function parseSettings(raw: unknown): RoomSettings {
  const fields = (raw ?? {}) as Partial<Record<keyof RoomSettings, unknown>>;
  const keepAlive = KEEP_ALIVES.find((k) => k === fields.keepAlive) ?? DEFAULTS.keepAlive;
  const turn = parseTurn(fields.turn);

  return {
    turn,
    keepAlive,
    hideQr: fields.hideQr === true,
    shareTurn: !!turn && fields.shareTurn === true,
    alwaysTurn: fields.alwaysTurn === true,
  };
}

export function loadSettings(): RoomSettings {
  try {
    return parseSettings(JSON.parse(load("settings") ?? "null"));
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(settings: RoomSettings) {
  save("settings", JSON.stringify(settings));
}
