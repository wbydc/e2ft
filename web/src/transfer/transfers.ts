// File offers and chunk streaming for one room: one outgoing and one incoming transfer at a time, each its
// own class (outgoing.ts, incoming.ts), over the room's current connection (wire format in wire.ts). One Transfers
// lives as long as the room: a dropped connection pauses a running transfer and the next one resumes it from the
// receiver's next chunk.
import { fileKey, fromB64url, toB64url } from "../crypto/keys.ts";
import type { Role, RoomCrypto } from "../crypto/keys.ts";
import { Sealer } from "../crypto/sealer.ts";
import type { Dir, TransferHooks } from "./events.ts";
import { Incoming } from "./incoming.ts";
import type { IncomingContext } from "./incoming.ts";
import { BUFFER_LOW, MAX_DIRECT } from "./constants.ts";
import type { LanePlan, Link } from "./lanes.ts";
import { Outgoing } from "./outgoing.ts";
import type { OutgoingContext } from "./outgoing.ts";
import { parseOffer, unframe } from "./wire.ts";
import type { ControlMessage, LaneMessage, Offer } from "./wire.ts";

/** After the user declines, the peer's offers are declined unseen for this long, so a peer can't re-offer in a loop. */
const DECLINE_QUIET_MS = 5_000;

export class Transfers {
  private link: Link | null = null;
  private outgoing: Outgoing | null = null;
  private incoming: Incoming | null = null;
  private pendingOffer: Offer | null = null;
  private quietUntil = 0;
  /** The last file we received, for a sender whose `received` was lost with the connection. */
  private lastDone: string | null = null;
  private nextTransferNumber = 0;
  // One chain for chunks of every connection, apart from control: a slow disk write never delays acks.
  private chunkTail = Promise.resolve();
  private readonly onChunk = (event: MessageEvent) => {
    this.chunkTail = this.chunkTail
      .then(() => this.receiveChunk(new Uint8Array(event.data as ArrayBuffer)))
      .catch((err) => this.hooks.fail(err));
  };
  private readonly outgoingContext: OutgoingContext;
  private readonly incomingContext: IncomingContext = {
    send: (message) => this.send(message),
    progress: (progress) => this.hooks.progress("in", progress),
    chunk: this.onChunk,
  };

  /** `fixedLanes` (`?lanes=N`): this many connections per outgoing transfer from the start, never adapted. */
  public constructor(
    private readonly room: RoomCrypto,
    private readonly role: Role,
    private readonly hooks: TransferHooks,
    fixedLanes: number | null = null,
  ) {
    this.outgoingContext = {
      room,
      fixedLanes,
      link: () => this.link,
      send: (message) => this.send(message),
      bothWays: () => this.incoming !== null,
    };
  }

  public get connected(): boolean {
    return this.link !== null;
  }

  /** A file is going out, paused ones included: no other may start. */
  public get busy(): boolean {
    return this.outgoing !== null;
  }

  /** Open connections carrying chunks per direction, 0 for a direction with no transfer running. */
  public get lanes(): { out: number; in: number } {
    const out = this.outgoing?.phase === "offered" || this.outgoing?.paused ? null : this.outgoing;

    return { out: out ? out.laneCount() : 0, in: this.incoming && this.link ? this.incoming.laneCount() : 0 };
  }

  /** A connection opened: carry chunks and control on it, and resume what the last one left paused. `plan` gives
   *  connection 0's current config and route, which extra connections follow. */
  public attach(data: RTCDataChannel, control: RTCDataChannel, plan: () => Promise<LanePlan>): void {
    // Each side makes a new sealer for each connection, so both restart its sequence together.
    const link: Link = { data, control, sealer: new Sealer(this.room.signal, "ctl", this.role), plan };
    this.link = link;

    data.bufferedAmountLowThreshold = BUFFER_LOW;
    data.onbufferedamountlow = () => this.outgoing?.poke();
    data.onmessage = this.onChunk;
    let controlTail = Promise.resolve();
    control.onmessage = (event) => {
      controlTail = controlTail
        .then(() => this.receive(link, event.data as string))
        .catch((err) => this.hooks.fail(err));
    };

    void this.resume(link).catch((err) => this.hooks.fail(err));
  }

  /** The connection dropped, the room maybe not: a running transfer pauses, an unanswered offer fails. */
  public detach(): void {
    this.link = null;

    const out = this.outgoing;
    if (out?.phase === "offered") {
      this.hooks.finished({ ...out.info(), dir: "out", outcome: "failed" });
      out.cancelled = true;
      this.outgoing = null;
      out.answer?.(false);
      this.hooks.progress("out", null);
    } else if (out) {
      out.pause();
      this.hooks.progress("out", { ...out.progress(), paused: true });
    }

    const incoming = this.incoming;
    if (incoming) {
      incoming.pause();
      this.hooks.progress("in", { ...incoming.progress(), paused: true });
    }
  }

  /** Offer a file; resolves when it was declined, cancelled, failed or received. */
  public async sendFile(file: File): Promise<void> {
    if (this.outgoing) throw new Error("already sending");

    const out = new Outgoing(file, this.nextTransferNumber++, this.outgoingContext);
    this.outgoing = out;
    const progress = (done: number, waiting = false) =>
      this.hooks.progress("out", { name: file.name, done, total: file.size, waiting });
    const accepted = await new Promise<boolean>((answer) => {
      out.answer = answer;
      this.send({ t: "offer", id: out.id, x: out.transferNumber, name: file.name, size: file.size, type: file.type });
      this.hooks.status((m) => m.waitingAccept(file.name), "info", true);
      progress(0, true);
    });
    if (!accepted) {
      if (this.outgoing === out) this.outgoing = null;
      if (!out.cancelled) {
        this.hooks.progress("out", null);
        this.hooks.status((m) => m.peerDeclined(file.name), "warning");
        this.hooks.finished({ ...out.info(), dir: "out", outcome: "declined" });
      }

      return;
    }

    this.hooks.status((m) => m.sendingFile(file.name), "info");
    progress(0);
    await out.run(() => this.hooks.status((m) => m.sent(file.name), "info"));
    if (out.cancelled) this.stopOutgoing(out);
  }

  public cancel(dir: Dir): void {
    if (dir === "out") {
      const out = this.outgoing;
      if (!out) return;

      this.hooks.status((m) => m.youCancelled(out.file.name), "info");
      this.hooks.finished({ ...out.info(), dir: "out", outcome: "cancelled" });
      this.stopOutgoing(out);

      return;
    }

    const incoming = this.incoming;
    if (!incoming) return;

    this.dropIncoming(incoming);
    void incoming.sink.abort();
    this.send({ t: "cancel", id: incoming.id });
    this.hooks.progress("in", null);
    this.hooks.status((m) => m.youCancelled(incoming.offer.name), "info");
    this.hooks.finished({ ...incoming.info(), dir: "in", outcome: "cancelled" });
  }

  /** The room ended: fail both transfers, paused ones included, and discard a half-written file. */
  public abort(): void {
    this.link = null;

    const incoming = this.incoming;
    if (incoming) {
      void incoming.sink.abort();
      this.hooks.finished({ ...incoming.info(), dir: "in", outcome: "failed" });
      this.dropIncoming(incoming);
      this.hooks.progress("in", null);
    }

    const out = this.outgoing;
    if (out) {
      out.closeLanes();
      if (!out.cancelled) this.hooks.finished({ ...out.info(), dir: "out", outcome: "failed" });
      out.cancelled = true;
      out.poke();
      out.answer?.(false);
      this.hooks.progress("out", null);
    }
    this.outgoing = null;
  }

  /** Dropped while no connection is open: whoever is told later learns it from `resume` or `pending`. */
  private send(message: ControlMessage): void {
    const link = this.link;
    if (!link) return;

    void link.sealer
      .seal(message)
      .then((sealed) => link.control.readyState === "open" && link.control.send(toB64url(sealed)));
  }

  /** Receiver: ask for the rest from the first chunk not written. Sender: say ours is still going, so a receiver
   *  that finished or cancelled it meanwhile ends it here too. */
  private async resume(link: Link): Promise<void> {
    const out = this.outgoing;
    if (out?.paused) this.send({ t: "pending", id: out.id });

    const incoming = this.incoming;
    if (!incoming) return;

    // Chunks the old connection delivered are written first, so `next` is exact.
    await this.chunkTail;
    const plan = await link.plan();
    if (this.link !== link || this.incoming !== incoming) return;

    incoming.plan = plan;
    this.send({ t: "resume", id: incoming.id, n: incoming.next });
    this.hooks.status((m) => m.receivingFile(incoming.offer.name), "info");
    this.hooks.progress("in", incoming.progress());
  }

  private async receive(link: Link, data: string): Promise<void> {
    if (typeof data !== "string") throw new Error("binary frame on the control channel");

    const message = (await link.sealer.open(fromB64url(data))) as ControlMessage;
    if (this.link !== link) return;

    const out = this.outgoing?.id === message?.id ? this.outgoing : null;
    switch (message?.t) {
      case "offer": {
        const offer = parseOffer(message);
        if (!offer) throw new Error("bad offer");
        if (this.incoming || this.pendingOffer || Date.now() < this.quietUntil) {
          return this.send({ t: "decline", id: offer.id });
        }

        this.pendingOffer = offer;
        // Not awaited: the modal must not block acks and answers for our own outgoing file.
        void this.answerOffer(offer, message.x).catch((err) => this.hooks.fail(err));

        return;
      }
      case "accept":
      case "decline":
        out?.answer?.(message.t === "accept");

        return;
      case "ack":
        if (out && Number.isSafeInteger(message.n)) {
          out.ack(message.n);
          if (!out.cancelled) this.hooks.progress("out", out.progress());
        }

        return;
      case "received":
        if (out) this.outgoingReceived(out);

        return;
      case "cancel":
        return this.peerCancelled(message.id);
      case "resume":
        if (!out) return this.send({ t: "cancel", id: message.id });
        if (out.canResumeAt(message.n)) this.resumeOutgoing(out, message.n);

        return;
      case "pending":
        if (this.incoming?.id === message.id) return;

        return this.send(
          message.id === this.lastDone ? { t: "received", id: message.id } : { t: "cancel", id: message.id },
        );
      case "lane":
      case "lane-ice":
        return this.laneSignal(message);
      default:
        throw new Error("unknown control message");
    }
  }

  private outgoingReceived(out: Outgoing): void {
    this.outgoing = null;
    out.received = true;
    out.poke();
    this.hooks.progress("out", { name: out.file.name, done: out.file.size, total: out.file.size });
    this.hooks.progress("out", null);
    this.hooks.status((m) => m.savedByPeer(out.file.name), "success");
    this.hooks.finished({ ...out.info(), dir: "out", outcome: "done" });
  }

  private resumeOutgoing(out: Outgoing, chunkIndex: number): void {
    out.resume(chunkIndex);
    this.hooks.status((m) => m.sendingFile(out.file.name), "info");
    this.hooks.progress("out", out.progress());
  }

  private peerCancelled(id: string): void {
    const out = this.outgoing;
    const pendingOffer = this.pendingOffer;
    const incoming = this.incoming;
    if (out?.id === id) {
      this.hooks.status((m) => m.peerCancelled(out.file.name), "warning");
      this.hooks.finished({ ...out.info(), dir: "out", outcome: "cancelled" });
      this.stopOutgoing(out);
    } else if (pendingOffer?.id === id) {
      this.pendingOffer = null;
      this.hooks.offerCancelled(pendingOffer);
      this.hooks.status((m) => m.peerWithdrew(pendingOffer.name), "warning");
      this.hooks.finished({ ...pendingOffer, dir: "in", outcome: "cancelled" });
    } else if (incoming?.id === id) {
      this.dropIncoming(incoming);
      void incoming.sink.abort();
      this.hooks.progress("in", null);
      this.hooks.status((m) => m.peerCancelled(incoming.offer.name), "warning");
      this.hooks.finished({ ...incoming.info(), dir: "in", outcome: "cancelled" });
    }
  }

  private dropIncoming(incoming: Incoming): void {
    if (this.incoming === incoming) this.incoming = null;
    incoming.end();
  }

  /** Ends our outgoing transfer; the "cancel" goes out once the chunk loop has stopped. */
  private stopOutgoing(out: Outgoing): void {
    out.cancelled = true;
    if (out.phase === "sending") {
      out.poke();

      return;
    }

    this.send({ t: "cancel", id: out.id });
    out.answer?.(false);
    if (this.outgoing === out) this.outgoing = null;
    this.hooks.progress("out", null);
  }

  private async answerOffer(offer: Offer, transferNumber: number): Promise<void> {
    const sink = await this.hooks.offer(offer);
    if (this.pendingOffer !== offer) {
      // Withdrawn by the sender while the user was deciding.
      await sink?.abort();

      return;
    }

    this.pendingOffer = null;
    if (!sink) {
      this.quietUntil = Date.now() + DECLINE_QUIET_MS;
      this.send({ t: "decline", id: offer.id });
      this.hooks.finished({ ...offer, dir: "in", outcome: "declined" });

      return;
    }

    const key = await fileKey(this.room, offer.id);
    const plan = await this.link?.plan();
    if (!plan) {
      // The connection dropped as the user accepted: the sender's offer failed with it.
      await sink.abort();
      this.hooks.finished({ ...offer, dir: "in", outcome: "failed" });

      return;
    }

    const incoming = new Incoming(offer, transferNumber, sink, key, plan, this.incomingContext);
    this.incoming = incoming;
    this.send({ t: "accept", id: offer.id });
    this.outgoing?.shrinkToHalf();
    this.hooks.status((m) => m.receivingFile(offer.name), "info");
    this.hooks.progress("in", { name: offer.name, done: 0, total: offer.size });
    if (offer.size === 0) await this.finishIncoming(incoming);
  }

  private async receiveChunk(frameBytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const { transferNumber, index, ciphertext } = unframe(frameBytes);
    const incoming = this.incoming;
    // Still in flight from a transfer that ended, or that we cancelled.
    if (incoming?.transferNumber !== transferNumber) return;

    if (await incoming.receive(index, ciphertext)) await this.finishIncoming(incoming);
  }

  /** Extra connections: the sender's offer opens one for our incoming transfer; answers and ICE reach our own. */
  private laneSignal(message: LaneMessage): void {
    const { id, n: laneNumber } = message;
    if (!Number.isInteger(laneNumber) || laneNumber < 1 || laneNumber >= MAX_DIRECT) return;

    if (this.outgoing?.id === id) this.outgoing.laneSignal(laneNumber, message);
    else if (this.incoming?.id === id) this.incoming.laneSignal(laneNumber, message);
  }

  private async finishIncoming(incoming: Incoming): Promise<void> {
    await incoming.sink.close();
    this.dropIncoming(incoming);
    this.lastDone = incoming.id;
    this.send({ t: "received", id: incoming.id });
    this.hooks.progress("in", null);
    this.hooks.status((m) => m.saved(incoming.offer.name), "success");
    this.hooks.finished({ ...incoming.info(), dir: "in", outcome: "done" });
  }
}
