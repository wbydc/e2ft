// AEAD: the sealed signalling stream and per-chunk file encryption, both AES-GCM via WebCrypto.
import type { Bytes, Role } from "./keys.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const peerOf = (r: Role): Role => (r === "creator" ? "joiner" : "creator");

/**
 * Sealed, ordered message stream for one direction pair over an untrusted relay.
 * Wire: iv(12, random) || AES-GCM(JSON {s: seq, m: msg}), AAD = "<label>:<sender role>".
 * The role in the AAD stops reflection of our own messages back to us; the strict seq stops replay,
 * reordering and drops. seal/open are serialized internally, so callers may fire them concurrently and
 * results resolve in call order.
 */
export class Sealer {
  private sendSeq = 0;
  private recvSeq = 0;
  private sendTail: Promise<unknown> = Promise.resolve();
  private recvTail: Promise<unknown> = Promise.resolve();
  private readonly sendAad: Bytes;
  private readonly recvAad: Bytes;

  constructor(
    private readonly key: CryptoKey,
    label: string,
    role: Role,
  ) {
    this.sendAad = encoder.encode(`${label}:${role}`);
    this.recvAad = encoder.encode(`${label}:${peerOf(role)}`);
  }

  public seal(message: unknown): Promise<Bytes> {
    const sealed = this.sendTail.then(async () => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = encoder.encode(JSON.stringify({ s: this.sendSeq++, m: message }));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: this.sendAad },
        this.key,
        plaintext,
      );
      const out = new Uint8Array(12 + ciphertext.byteLength);
      out.set(iv);
      out.set(new Uint8Array(ciphertext), 12);

      return out;
    });
    this.sendTail = sealed.catch(() => {});

    return sealed;
  }

  /** Rejects on a bad tag or an out-of-order seq; after a rejection the stream is unusable. */
  public open(data: Bytes): Promise<unknown> {
    const opened = this.recvTail.then(async () => {
      if (data.byteLength < 12 + 16) throw new Error("sealed message too short");

      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: data.subarray(0, 12), additionalData: this.recvAad },
        this.key,
        data.subarray(12),
      );
      const { s: sequence, m: message } = JSON.parse(decoder.decode(plaintext)) as { s: unknown; m: unknown };
      if (sequence !== this.recvSeq) throw new Error("sealed message out of order");
      this.recvSeq++;

      return message;
    });
    this.recvTail = opened;

    return opened;
  }
}

function chunkIv(index: number): Bytes {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(index));

  return iv;
}

export async function sealChunk(key: CryptoKey, index: number, data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: chunkIv(index) }, key, data));
}

export async function openChunk(key: CryptoKey, index: number, data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: chunkIv(index) }, key, data));
}
