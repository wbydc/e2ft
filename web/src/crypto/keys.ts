// Room key derivation: HKDF over the CPace session key, per-transfer file keys, and the
// random tokens nobody types. WebCrypto for all of it; only the CPace curve math comes from noble (cpace.ts).
import { parseAccessKey } from "./invite.ts";

export type Bytes = Uint8Array<ArrayBuffer>;
export type Role = "creator" | "joiner";

const encoder = new TextEncoder();

export function toB64url(bytes: Bytes): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Bytes {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));

  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** 128 random bits as 22 base64url chars: the seat token and transferId, which nobody types. */
export function randomKey(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(16)));
}

export interface RoomCrypto {
  accessKey: string;
  base: CryptoKey;
  signal: CryptoKey;
}

function hkdfAes(base: CryptoKey, info: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("e2ft/v1"), info: encoder.encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Room keys from the CPace session key. Zeroes `isk` once WebCrypto holds it. */
export async function roomCrypto(accessKey: string, isk: Bytes): Promise<RoomCrypto> {
  if (accessKey !== parseAccessKey(accessKey) || isk.byteLength !== 64) throw new Error("bad key format");

  const base = await crypto.subtle.importKey("raw", isk, "HKDF", false, ["deriveKey", "deriveBits"]);
  isk.fill(0);

  return { accessKey, base, signal: await hkdfAes(base, `signal/${accessKey}`) };
}

/** The 6 digits both screens of a discovered room show: equal only when both hold the same session
 *  key, which a relay sitting between two exchanges cannot arrange. */
export async function compareCode(room: RoomCrypto): Promise<string> {
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("e2ft/v1"), info: encoder.encode(`sas/${room.accessKey}`) },
    room.base,
    32,
  );

  return String(new DataView(bits).getUint32(0) % 1_000_000).padStart(6, "0");
}

/** Per-transfer key: the transferId is random per file, so chunk counters never repeat under one key. */
export function fileKey(room: RoomCrypto, transferId: string): Promise<CryptoKey> {
  return hkdfAes(room.base, `file/${room.accessKey}/${transferId}`);
}
