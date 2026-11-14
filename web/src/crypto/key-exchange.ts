// One CPace run with the draft's explicit key confirmation (draft-irtf-cfrg-cpace-21 §10.4), the creator as A:
// send our share, take the peer's and send our tag, check the peer's tag; only then is ISK released. The math is
// in cpace.ts (its header explains the names).
import { calculateGenerator, concat, deriveIsk, lvCat, sampleScalar, scalarMultVfy, sha512 } from "./cpace.ts";
import type { Ristretto } from "./cpace.ts";
import type { Bytes, Role } from "./keys.ts";

const encoder = new TextEncoder();
const SID = new Uint8Array(0);
/** The role names are the associated data, so a relay reflecting one side's share or tag back to it fails. */
const AD: Record<Role, Bytes> = { creator: encoder.encode("creator"), joiner: encoder.encode("joiner") };
const peerOf = (r: Role): Role => (r === "creator" ? "joiner" : "creator");
const COMMIT = encoder.encode("e2ft/v1/commit");

/** The hash a discovered room's creator sends before its share: it fixes the share, and so the compared
 *  code, before the creator has seen the joiner's share, and the joiner answers before it has seen the creator's. */
export const commitTo = (share: Uint8Array): Promise<Bytes> => sha512(concat(COMMIT, share));

/** Whether `share` is the one `commitment` was made to. Both are public, so the comparison need not be constant-time. */
export async function opensCommitment(commitment: Uint8Array, share: Uint8Array): Promise<boolean> {
  const expected = await commitTo(share);

  return commitment.byteLength === expected.byteLength && expected.every((byte, i) => byte === commitment[i]);
}

export class KeyExchange {
  /** Set by receive() once our tag exists; verify() needs them. */
  private confirm: { peerShare: Uint8Array; mac: CryptoKey; isk: Bytes } | null = null;

  private constructor(
    private readonly ristretto: Ristretto,
    private readonly role: Role,
    /** Our public share Y, 32 bytes, sent first. */
    public readonly share: Bytes,
    /** Our secret scalar, until the peer's share has used it. */
    private y: bigint | null,
  ) {}

  /** `password` is the 6-char secret; `ci` binds the run to the room (both sides must agree on it). */
  public static async start(ristretto: Ristretto, role: Role, password: string, ci: Uint8Array): Promise<KeyExchange> {
    const prs = encoder.encode(password);
    const gen = await calculateGenerator(ristretto, prs, ci, SID);
    prs.fill(0);

    const y = sampleScalar();

    return new KeyExchange(ristretto, role, gen.multiply(y).toBytes(), y);
  }

  /** Takes the peer's share and returns our key-confirmation tag (64 bytes, sent second), or null if the share is
   *  invalid; either way the exchange takes no other share. */
  public async receive(peerShare: Uint8Array): Promise<Bytes | null> {
    if (this.y === null) throw new Error("CPace exchange already used");
    const K = peerShare.byteLength === 32 ? scalarMultVfy(this.ristretto, this.y, peerShare) : null;
    this.y = null;
    if (!K) return null;

    const [Ya, Yb] = this.role === "creator" ? [this.share, peerShare] : [peerShare, this.share];
    const isk = await deriveIsk(SID, K, Ya, AD.creator, Yb, AD.joiner);
    K.fill(0);
    const macBytes = await sha512(concat(encoder.encode("CPaceMac"), SID, isk));
    const mac = await crypto.subtle.importKey("raw", macBytes, { name: "HMAC", hash: "SHA-512" }, false, [
      "sign",
      "verify",
    ]);
    macBytes.fill(0);
    const tag = new Uint8Array(await crypto.subtle.sign("HMAC", mac, lvCat(this.share, AD[this.role])));
    this.confirm = { peerShare, mac, isk };

    return tag;
  }

  /** Checks the peer's tag; on success returns ISK (64 bytes) for roomCrypto(), else null and ISK is wiped. */
  public async verify(peerTag: Uint8Array): Promise<Bytes | null> {
    if (!this.confirm) throw new Error("CPace tag checked before the peer's share");
    const ok =
      peerTag.byteLength === 64 &&
      (await crypto.subtle.verify(
        "HMAC",
        this.confirm.mac,
        peerTag as Bytes,
        lvCat(this.confirm.peerShare, AD[peerOf(this.role)]),
      ));
    if (ok) return this.confirm.isk;

    this.confirm.isk.fill(0);

    return null;
  }
}
