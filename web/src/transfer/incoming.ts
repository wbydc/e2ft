// One file we receive. Chunks arrive on connection 0 and the sender's extra connections in any order; each is
// opened as it arrives, so only authenticated ones are held, and at most WINDOW of them wait for the gap before them.
// They are written in order and acked every ACK_EVERY chunks or ACK_MS.
import { openChunk } from "../crypto/sealer.ts";
import type { Bytes } from "../crypto/keys.ts";
import { Lane } from "../net/lane.ts";
import { ACK_EVERY, ACK_MS } from "./constants.ts";
import type { FileInfo, Progress } from "./events.ts";
import { closeLanes, laneConfig, openLanes } from "./lanes.ts";
import type { LanePlan } from "./lanes.ts";
import { Reorder } from "./reorder.ts";
import type { Sink } from "./sink.ts";
import { WINDOW } from "./wire.ts";
import type { ControlMessage, LaneMessage, Offer } from "./wire.ts";

/** What an incoming transfer needs from the Transfers that owns it. */
export interface IncomingContext {
  send(message: ControlMessage): void;
  progress(progress: Progress): void;
  /** Handles a chunk frame from any connection. */
  chunk(event: MessageEvent): void;
}

export class Incoming {
  /** Bytes written so far. */
  public bytes = 0;
  /** Finished, cancelled or failed: chunks still in flight are dropped. */
  public ended = false;
  /** Extra connections by number; connection 0 is the room's. */
  private readonly lanes = new Map<number, Lane>();
  private readonly order = new Reorder<Bytes>(WINDOW);
  private ackedAt = performance.now();

  public constructor(
    public readonly offer: Offer,
    public readonly transferNumber: number,
    public readonly sink: Sink,
    private readonly key: CryptoKey,
    /** Connection 0's plan, which extra connections follow; renewed by each new connection. */
    public plan: LanePlan,
    private readonly context: IncomingContext,
  ) {}

  public get id(): string {
    return this.offer.id;
  }

  /** Chunks the sender may skip: everything before the first one not written. */
  public get next(): number {
    return this.order.next;
  }

  public info(): FileInfo {
    const { id, name, size, type } = this.offer;

    return { id, name, size, type };
  }

  public progress(): Progress {
    return { name: this.offer.name, done: this.bytes, total: this.offer.size };
  }

  public laneCount(): number {
    return openLanes(this.lanes);
  }

  /** Opens chunk `index` and writes every chunk now in order; resolves true once the whole file is written. */
  public async receive(index: number, ciphertext: Bytes): Promise<boolean> {
    const chunk = await openChunk(this.key, index, ciphertext);
    if (this.ended || !this.order.put(index, chunk)) return false;

    const first = this.order.next;
    const run = this.order.take();
    for (let offset = 0; offset < run.length; offset++) {
      const chunkIndex = first + offset;
      this.bytes += run[offset].byteLength;
      if (this.bytes > this.offer.size) throw new Error("more data than offered");

      try {
        await this.sink.write(run[offset]);
      } catch (err) {
        if (this.ended) return false;
        throw err;
      }
      if (this.ended) return false;

      const now = performance.now();
      if ((chunkIndex + 1) % ACK_EVERY === 0 || now - this.ackedAt >= ACK_MS) {
        this.ackedAt = now;
        this.context.send({ t: "ack", id: this.id, n: chunkIndex + 1 });
      }
      this.context.progress(this.progress());
      if (this.bytes === this.offer.size) return true;
    }

    return false;
  }

  /** The sender's offer opens extra connection `laneNumber`; its ICE follows. */
  public laneSignal(laneNumber: number, message: LaneMessage): void {
    let lane = this.lanes.get(laneNumber);
    if (!lane && message.t === "lane") {
      const made = new Lane(
        laneConfig(this.plan),
        false,
        (signal) => this.context.send({ ...signal, id: this.id, n: laneNumber }),
        () => {
          if (this.lanes.get(laneNumber) === made) this.lanes.delete(laneNumber);
        },
      );
      made.channel.onmessage = (event) => this.context.chunk(event);
      this.lanes.set(laneNumber, made);
      lane = made;
    }
    lane?.signal(message);
  }

  /** The connection dropped: its extra connections go with it, the sender opens new ones on the next. */
  public pause(): void {
    closeLanes(this.lanes);
  }

  public end(): void {
    this.ended = true;
    closeLanes(this.lanes);
  }
}
