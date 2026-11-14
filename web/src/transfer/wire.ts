// What two Transfers send each other. Control messages are sealed (label "ctl") and sent as base64url text on
// connection 0's "ctl" channel. Chunks are binary frames `[u32 tx][u32 index] || sealChunk(key, index, plaintext)` on
// connection 0's "share" channel and the sender's extra connections; each chunk is AES-GCM sealed with a per-transfer
// key at its index, so a forged index fails and a chunk is valid on any connection. `tx` numbers the
// sender's offers, so frames of an ended transfer are dropped.
import type { Bytes } from "../crypto/keys.ts";
import type { LaneSignal } from "../net/lane.ts";
import { CONFIG } from "../config.ts";

export interface Offer {
  id: string;
  name: string;
  size: number;
  type: string;
}

export type ControlMessage =
  | ({ t: "offer"; x: number } & Offer)
  | { t: "accept"; id: string }
  | { t: "decline"; id: string }
  | { t: "ack"; id: string; n: number }
  | { t: "received"; id: string }
  | { t: "cancel"; id: string }
  /** Receiver, on a new connection: continue from chunk `n`. Sender: `id` is still going. */
  | { t: "resume"; id: string; n: number }
  | { t: "pending"; id: string }
  /** `n`: the extra connection, 1 to MAX_DIRECT - 1. */
  | LaneMessage;

export type LaneMessage = LaneSignal & { id: string; n: number };

/** Plaintext bytes per sealed chunk the sender reads from the file. */
export const CHUNK_SIZE = CONFIG.CHUNK_SIZE;
/** Chunks the sender may run ahead of the receiver's disk writes (64 MiB by default); the receiver reorders at most this many. */
export const WINDOW = CONFIG.WINDOW;
const FRAME_HEAD = 8;

/** The sender's `randomKey()`: 128 bits as 22 base64url chars. */
const TRANSFER_ID = /^[A-Za-z0-9_-]{22}$/;

/** A file name as the peer may give it: no control or format characters that could reorder the text around it
 *  (a right-to-left override can turn `exe.pdf` into `fdp.exe`), no path separators, at most 255 chars. */
export function cleanFileName(name: string): string {
  const cleaned = Array.from(
    name
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .replace(/[/\\:]/g, "_")
      .trim(),
  )
    .slice(0, 255)
    .join("")
    .trim();

  return cleaned || "file";
}

export function parseOffer(message: { t: "offer"; x: number } & Offer): Offer | null {
  const ok =
    typeof message.id === "string" &&
    TRANSFER_ID.test(message.id) &&
    typeof message.name === "string" &&
    typeof message.type === "string" &&
    Number.isSafeInteger(message.size) &&
    message.size >= 0 &&
    Number.isSafeInteger(message.x) &&
    message.x >= 0 &&
    message.x <= 0xffffffff;

  return ok
    ? { id: message.id, name: cleanFileName(message.name), size: message.size, type: message.type.slice(0, 255) }
    : null;
}

export function frame(transferNumber: number, index: number, ciphertext: Bytes): Bytes {
  const frameBytes = new Uint8Array(FRAME_HEAD + ciphertext.byteLength);
  const head = new DataView(frameBytes.buffer);
  head.setUint32(0, transferNumber);
  head.setUint32(4, index);
  frameBytes.set(ciphertext, FRAME_HEAD);

  return frameBytes;
}

export function unframe(frameBytes: Bytes): { transferNumber: number; index: number; ciphertext: Bytes } {
  if (frameBytes.byteLength < FRAME_HEAD) throw new Error("chunk frame too short");

  const head = new DataView(frameBytes.buffer, frameBytes.byteOffset, FRAME_HEAD);

  return { transferNumber: head.getUint32(0), index: head.getUint32(4), ciphertext: frameBytes.subarray(FRAME_HEAD) };
}
