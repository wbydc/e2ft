// The CPace math of draft-irtf-cfrg-cpace-21 on ristretto255 with SHA-512, function by function as the
// draft names them; the encodings, generator, K and ISK are checked against its test vectors (cpace.test.ts). One
// run of the protocol with key confirmation is KeyExchange in exchange.ts. WebCrypto hashes; noble does only the
// group math and is passed in, so the page can load it lazily (crypto/ristretto.ts) and tests can import it directly.
//
// The draft's names, kept so the code can be read side by side with it:
//   PRS  password-related string: the 6-char secret's bytes.
//   CI   channel identifier: binds a run to its room ("e2ft/v1" and the access key, see signal.ts).
//   sid  session id: empty here, the room binds through CI.
//   DSI  domain separation string.
//   gen  the generator, a point derived from PRS, CI and sid (`ristretto` in the code is the noble library);
//   y    a secret scalar;  Y = y * gen, a public share.
//   K    the shared point y_a * Y_b = y_b * Y_a.     AD  associated data: here the role name.
//   ISK  intermediate session key, 64 bytes: the output, fed to roomCrypto().
import type { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import type { Bytes } from "./keys.ts";

export interface Ristretto {
  ristretto255: typeof ristretto255;
  ristretto255_hasher: typeof ristretto255_hasher;
}
type Point = InstanceType<Ristretto["ristretto255"]["Point"]>;

const encoder = new TextEncoder();
const DSI = encoder.encode("CPaceRistretto255");
const DSI_ISK = encoder.encode("CPaceRistretto255_ISK");
const SHA512_BLOCK = 128;

/** Plain concatenation. */
export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }

  return out;
}

/** The length as LEB128, then the data */
export function prependLen(data: Uint8Array): Bytes {
  const lengthBytes: number[] = [];
  let remaining = data.byteLength;
  do {
    lengthBytes.push((remaining & 0x7f) | (remaining >= 128 ? 0x80 : 0));
    remaining >>>= 7;
  } while (remaining);

  return concat(Uint8Array.from(lengthBytes), data);
}

/** Each part length-prefixed, then concatenated */
export const lvCat = (...parts: Uint8Array[]): Bytes => concat(...parts.map(prependLen));

export async function sha512(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-512", data as Bytes));
}

/** The hash input for the generator, zero-padded so DSI and PRS fill the first SHA-512 block */
export function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Bytes {
  const zpad = Math.max(0, SHA512_BLOCK - 1 - prependLen(prs).byteLength - prependLen(DSI).byteLength);

  return lvCat(DSI, prs, new Uint8Array(zpad), ci, sid);
}

/** gen: hash the generator string, then map it to a point */
export async function calculateGenerator(
  ristretto: Ristretto,
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
): Promise<Point> {
  const hash = await sha512(generatorString(prs, ci, sid));

  return ristretto.ristretto255_hasher.deriveToCurve!(hash);
}

const leToBigint = (b: Uint8Array) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);

/** 32 random bytes with the bits above 252 cleared, little-endian (§8.3); below the group order, so never reduced. */
export function sampleScalar(): bigint {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    bytes[31] &= 0x0f;
    const y = leToBigint(bytes);
    bytes.fill(0);
    if (y !== 0n) return y;
  }
}

export const scalarFromLe = leToBigint;

/** `encode(y * decode(X))`, or null where the draft returns G.I: X does not decode, or the result is the identity. */
export function scalarMultVfy(ristretto: Ristretto, y: bigint, X: Uint8Array): Bytes | null {
  let point: Point;
  try {
    point = ristretto.ristretto255.Point.fromBytes(X);
  } catch {
    return null;
  }

  if (point.is0()) return null;
  const product = point.multiply(y);

  return product.is0() ? null : product.toBytes();
}

/** ISK = H(DSI_ISK, sid, K, then each share with its AD) */
export async function deriveIsk(
  sid: Uint8Array,
  K: Uint8Array,
  Ya: Uint8Array,
  ADa: Uint8Array,
  Yb: Uint8Array,
  ADb: Uint8Array,
): Promise<Bytes> {
  return sha512(concat(lvCat(DSI_ISK, sid, K), lvCat(Ya, ADa), lvCat(Yb, ADb)));
}
