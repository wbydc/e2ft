// Invite formats: the access key, the secret and the room hints in the link fragment, all in
// Crockford base32 so people can type them.
import { CONFIG } from "../config.ts";
import type { Connection } from "../net/ice.ts";

/** Crockford base32: what people type, so case-insensitive and without I, L, O, U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_INDEX = new Map(CROCKFORD.split("").map((c, i) => [c, i] as const));
/** Build-time settings: 8 and 6 by default, and the server checks the same ACCESS_LEN. */
export const ACCESS_LEN = CONFIG.ACCESS_LEN;
export const SECRET_LEN = CONFIG.SECRET_LEN;
const FLAGS_LEN = 2;

/** The creator's non-default room settings, carried in the invite fragment as untrusted hints. */
export type InviteHints = { keepAlive: number; connection: Connection; shareTurn: boolean };

const DEFAULT_HINTS: InviteHints = { keepAlive: CONFIG.KEEP_ALIVE, connection: "auto", shareTurn: false };
// Bits 0-2 of the 10-bit flags index this list, bits 3-4 CONN_ORDER, bit 5 is shareTurn, bits 6-9 are spare.
// The default keep-alive first, so a default room's config is "00".
const KA_ORDER = [CONFIG.KEEP_ALIVE, ...CONFIG.KEEP_ALIVES.filter((k) => k !== CONFIG.KEEP_ALIVE)];
const CONN_ORDER = ["auto", "relay", "tcp"] as const;
const SHARE_BIT = 1 << 5;

/** Typed or scanned text in canonical form: upper case, `-` and spaces dropped, I/L read as 1 and O as 0. */
export function normalizeKey(text: string): string | null {
  const canonical = text.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");

  return canonical.split("").every((c) => CROCKFORD_INDEX.has(c)) ? canonical : null;
}

/** The ACCESS_LEN-char room id the server sees (8 chars, 40 bits by default), canonical, or null. */
export function parseAccessKey(text: string): string | null {
  const key = normalizeKey(text);

  return key?.length === ACCESS_LEN ? key : null;
}

function randomCrockford(length: number): string {
  // 256 is a multiple of 32, so the low 5 bits of a random byte are uniform.
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => CROCKFORD[b & 31]).join("");
}

/** The room id of a room with no invite, made for a discovered device. */
export const newAccessKey = (): string => randomCrockford(ACCESS_LEN);

/** The 2 config chars, then the SECRET_LEN-char secret. A default room's config is "00". */
export function inviteFragment(secret: string, hints: InviteHints): string {
  const flags =
    KA_ORDER.indexOf(hints.keepAlive) | (CONN_ORDER.indexOf(hints.connection) << 3) | (hints.shareTurn ? SHARE_BIT : 0);

  return CROCKFORD[flags >> 5] + CROCKFORD[flags & 31] + secret;
}

/** `""` is a default room; two config chars give their hints, spare bits ignored; anything else is unknown. */
function parseHints(prefix: string): InviteHints | null {
  if (!prefix) return { ...DEFAULT_HINTS };
  if (prefix.length !== FLAGS_LEN) return null;

  const flags = CROCKFORD_INDEX.get(prefix[0])! * 32 + CROCKFORD_INDEX.get(prefix[1])!;
  const keepAliveIndex = flags & 7;
  const connectionIndex = (flags >> 3) & 3;
  if (keepAliveIndex >= KA_ORDER.length || connectionIndex >= CONN_ORDER.length) return null;

  return {
    keepAlive: KA_ORDER[keepAliveIndex],
    connection: CONN_ORDER[connectionIndex],
    shareTurn: (flags & SHARE_BIT) !== 0,
  };
}

/**
 * The secret and hints from an invite fragment (`<config><secret>`) or a bare secret, typed in any
 * case. The last SECRET_LEN chars are the secret; unreadable config means unknown hints, never a refused join.
 */
export function parseFragment(fragment: string): { secret: string; hints: InviteHints | null } | null {
  const normalized = normalizeKey(fragment);
  if (!normalized || normalized.length < SECRET_LEN) return null;

  return { secret: normalized.slice(-SECRET_LEN), hints: parseHints(normalized.slice(0, -SECRET_LEN)) };
}

/** A room's invite: the access key the server sees, the secret only the two browsers know, and the creator's
 *  room hints, or null when the invite's config chars could not be read. */
export class Invite {
  constructor(
    public readonly accessKey: string,
    public readonly secret: string,
    public readonly hints: InviteHints | null,
  ) {}

  /** A new room: 5 random bits per char of access key and of secret, the CPace password. Only the three
   *  hint fields are kept, whatever else the object holds. */
  public static create({ keepAlive, connection, shareTurn }: InviteHints): Invite {
    return new Invite(randomCrockford(ACCESS_LEN), randomCrockford(SECRET_LEN), { keepAlive, connection, shareTurn });
  }

  /** The two keys as typed into the join form, in any case; the secret field may hold the whole fragment. */
  public static fromTyped(accessText: string, secretText: string): Invite | null {
    const accessKey = parseAccessKey(accessText);
    const parsed = parseFragment(secretText);

    return accessKey && parsed ? new Invite(accessKey, parsed.secret, parsed.hints) : null;
  }

  /** An invite link (`<origin>/r/<accessKey>#<fragment>`) for this origin only, e.g. a scanned QR. */
  public static parse(text: string, origin: string): Invite | null {
    if (!URL.canParse(text)) return null;

    const url = new URL(text);
    const accessKey = parseAccessKey(url.pathname.match(/^\/r\/([^/]+)$/)?.[1] ?? "");
    if (url.origin !== origin || !accessKey || url.search) return null;

    const parsed = parseFragment(url.hash.slice(1));

    return parsed && new Invite(accessKey, parsed.secret, parsed.hints);
  }

  /** The creator's fragment: 2 config chars, then the secret. Only an invite with known hints has one. */
  public fragment(): string {
    if (!this.hints) throw new Error("an invite with unknown hints has no fragment");

    return inviteFragment(this.secret, this.hints);
  }

  public link(origin: string): string {
    return `${origin}/r/${this.accessKey}#${this.fragment()}`;
  }
}
