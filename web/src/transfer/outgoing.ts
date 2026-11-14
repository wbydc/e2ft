// One file we send. Once accepted, its chunks stream over connection 0 and extra connections it opens while
// each lifts the send rate. The file is read in chunks, never held whole: the loop waits
// for channel drain and the receiver's acks, so at most WINDOW chunks are unacked. A dropped connection pauses it
// until the receiver's `resume` says which chunk to go on from.
import { fileKey, randomKey } from "../crypto/keys.ts";
import type { RoomCrypto } from "../crypto/keys.ts";
import { sealChunk } from "../crypto/sealer.ts";
import { Lane } from "../net/lane.ts";
import type { FileInfo, Progress } from "./events.ts";
import { BUFFER_HIGH, BUFFER_LOW, GAIN, LANE_OPEN_MS, STEP_MS } from "./constants.ts";
import { closeLanes, laneCap, laneConfig, openLanes } from "./lanes.ts";
import type { LanePlan, Link } from "./lanes.ts";
import { CHUNK_SIZE, frame, WINDOW } from "./wire.ts";
import type { ControlMessage, LaneMessage } from "./wire.ts";

/** What an outgoing transfer needs from the Transfers that owns it. */
export interface OutgoingContext {
  readonly room: RoomCrypto;
  /** `?lanes=N`: this many connections from the start, never adapted; null adapts. */
  readonly fixedLanes: number | null;
  /** Connection 0, or null while the room has no connection. */
  link(): Link | null;
  send(message: ControlMessage): void;
  /** A file is coming in too, so each direction gets half the TURN quota. */
  bothWays(): boolean;
}

export class Outgoing {
  public readonly id = randomKey();
  public phase: "offered" | "sending" | "sent" = "offered";
  public acked = 0;
  public cancelled = false;
  /** The receiver has the whole file: the chunk loop stops. */
  public received = false;
  /** Sending, but the connection dropped: waits for the receiver's `resume`. */
  public paused = false;
  /** Set while the offer waits: resolves it with the receiver's answer. */
  public answer?: (accepted: boolean) => void;
  /** Extra connections by number; connection 0 is the room's. */
  private readonly lanes = new Map<number, Lane>();
  /** Chunks handed over at least once. */
  private sent = 0;
  /** Frame bytes handed to any connection, for the growth rate. */
  private handed = 0;
  private wake?: () => void;
  private plan?: LanePlan;
  /** The connection each chunk of the window went on, at index % WINDOW. */
  private readonly laneOf = new Uint8Array(WINDOW);
  /** Chunks lost with a failed connection, sent again before fresh ones, lowest first. */
  private resend: number[] = [];
  /** Bumped on each resume, so the growth loop of an old connection stops. */
  private gen = 0;

  public constructor(
    public readonly file: File,
    public readonly transferNumber: number,
    private readonly context: OutgoingContext,
  ) {}

  public info(): FileInfo {
    return { id: this.id, name: this.file.name, size: this.file.size, type: this.file.type };
  }

  public progress(): Progress {
    return { name: this.file.name, done: Math.min(this.acked * CHUNK_SIZE, this.file.size), total: this.file.size };
  }

  /** Lets the chunk loop look again: a channel drained, an ack came, or the transfer ended. */
  public poke(): void {
    this.wake?.();
  }

  public laneCount(): number {
    return openLanes(this.lanes);
  }

  public closeLanes(): void {
    closeLanes(this.lanes);
  }

  public ack(chunks: number): void {
    this.acked = Math.max(this.acked, chunks);
    this.poke();
  }

  /** Whether the receiver may ask to resume from `chunkIndex`: only chunks we handed over can be missing. */
  public canResumeAt(chunkIndex: number): boolean {
    return this.paused && Number.isSafeInteger(chunkIndex) && chunkIndex >= 0 && chunkIndex <= this.sent;
  }

  /** Streams the accepted file until the receiver has it or the transfer ends. `allSent` fires once every chunk went
   *  out the first time. */
  public async run(allSent: () => void): Promise<void> {
    this.phase = "sending";

    const key = await fileKey(this.context.room, this.id);
    const total = Math.ceil(this.file.size / CHUNK_SIZE);
    let saidSent = false;
    void this.grow();

    // Runs until received, not until every chunk went once: a failed connection's chunks may need sending again.
    try {
      while (this.running()) {
        if (!saidSent && this.sent === total) {
          saidSent = true;
          allSent();
        }

        while (this.resend[0] < this.acked) this.resend.shift();
        const next = this.resend[0] ?? this.sent;
        const link = this.context.link();
        if (
          this.paused ||
          !link ||
          next >= total ||
          next - this.acked >= WINDOW ||
          this.pickLane(link)[1].bufferedAmount > BUFFER_HIGH
        ) {
          await new Promise<void>((wake) => (this.wake = wake));
          continue;
        }

        const index = this.resend.length ? this.resend.shift()! : this.sent++;
        // Counted on connection 0, which never drops alone, until sent: a connection failing meanwhile must not queue it.
        this.laneOf[index % WINDOW] = 0;
        const plaintext = new Uint8Array(
          await this.file.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE).arrayBuffer(),
        );
        const ciphertext = await sealChunk(key, index, plaintext);
        if (!this.running()) break;
        // Dropped meanwhile: the resume restarts from the receiver's next chunk, which is at most this one.
        if (this.paused || this.context.link() !== link) continue;

        const [laneNumber, channel] = this.pickLane(link);
        const frameBytes = frame(this.transferNumber, index, ciphertext);
        channel.send(frameBytes);
        this.handed += frameBytes.byteLength;
        this.laneOf[index % WINDOW] = laneNumber;
      }
    } finally {
      this.closeLanes();
    }

    this.phase = "sent";
  }

  /** The connection dropped: wait for the next one, with no extra connections. */
  public pause(): void {
    this.paused = true;
    this.closeLanes();
  }

  /** Continue a paused transfer from chunk `chunkIndex` on the new connection, its lanes grown again from one. */
  public resume(chunkIndex: number): void {
    this.paused = false;
    this.gen++;
    this.acked = this.sent = chunkIndex;
    this.resend = [];
    void this.grow();
    this.poke();
  }

  /** Files now go both ways: give back the lanes over this direction's half of the TURN quota. */
  public shrinkToHalf(): void {
    while (this.plan && this.lanes.size + 1 > laneCap(this.plan, true)) this.dropLane(Math.max(...this.lanes.keys()));
  }

  /** The receiver's answer and ICE for one of our extra connections. */
  public laneSignal(laneNumber: number, message: LaneMessage): void {
    this.lanes.get(laneNumber)?.signal(message);
  }

  private running(): boolean {
    return !this.cancelled && !this.received;
  }

  /** The open connection with the least data queued, as its number and channel. */
  private pickLane(link: Link): [number, RTCDataChannel] {
    let best: [number, RTCDataChannel] = [0, link.data];
    for (const [laneNumber, lane] of this.lanes) {
      if (lane.channel.readyState === "open" && lane.channel.bufferedAmount < best[1].bufferedAmount) {
        best = [laneNumber, lane.channel];
      }
    }

    return best;
  }

  /** Adds connections while each lifts the send rate by GAIN, up to laneCap; `?lanes=N`
   *  opens them all at once (within laneCap) and never adapts. */
  private async grow(): Promise<void> {
    const link = this.context.link();
    if (!link) return;

    // Snapshot: a resume bumps `gen`, and this loop belongs to the connection it started on.
    const gen = this.gen;
    const live = () => this.running() && !this.paused && this.gen === gen;
    const plan = await link.plan();
    this.plan = plan;
    if (!live()) return;

    if (this.context.fixedLanes !== null) {
      const limit = Math.min(this.context.fixedLanes, laneCap(plan, this.context.bothWays()));
      for (let laneNumber = 1; laneNumber < limit; laneNumber++) void this.addLane(laneNumber);

      return;
    }

    // Bytes that left the connections' send buffers, not acks: an ack counts chunks written in order, so a new
    // connection's chunks wait behind connection 0's 8 MiB backlog, about a minute on a 150 kB/s link.
    const left = () =>
      this.handed -
      [link.data, ...[...this.lanes.values()].map((lane) => lane.channel)].reduce(
        (queued, channel) => queued + channel.bufferedAmount,
        0,
      );
    const ratePerStep = async () => {
      const from = left();
      await new Promise((resolve) => setTimeout(resolve, STEP_MS));

      return left() - from;
    };
    let previous = await ratePerStep();
    // Not once every chunk went: a connection opened for the tail costs coturn allocations and helps no one.
    const more = () => live() && this.sent * CHUNK_SIZE < this.file.size;
    for (let laneNumber = 1; this.lanes.size + 1 < laneCap(plan, this.context.bothWays()) && more(); laneNumber++) {
      if (!(await this.addLane(laneNumber))) return;

      const rate = await ratePerStep();
      if (!more()) return;
      if (rate < previous) return this.dropLane(laneNumber);
      if (rate === 0 || rate < GAIN * previous) return;
      previous = rate;
    }
  }

  /** Resolves true once connection `laneNumber` is open, false when it failed or did not open within LANE_OPEN_MS. */
  private addLane(laneNumber: number): Promise<boolean> {
    return new Promise((opened) => {
      const lane = new Lane(
        laneConfig(this.plan!),
        true,
        (signal) => this.context.send({ ...signal, id: this.id, n: laneNumber }),
        () => {
          opened(false);
          this.dropLane(laneNumber);
        },
      );
      lane.channel.bufferedAmountLowThreshold = BUFFER_LOW;
      lane.channel.onbufferedamountlow = () => this.poke();
      lane.channel.onopen = () => {
        opened(true);
        this.poke();
      };
      this.lanes.set(laneNumber, lane);

      setTimeout(() => {
        if (lane.channel.readyState === "open") return;

        opened(false);
        this.dropLane(laneNumber);
      }, LANE_OPEN_MS);
    });
  }

  /** Connection `laneNumber` failed or is not worth keeping: its chunks not yet acked go again on the others. */
  private dropLane(laneNumber: number): void {
    const lane = this.lanes.get(laneNumber);
    if (!lane) return;

    this.lanes.delete(laneNumber);
    lane.close();
    for (let index = this.acked; index < this.sent; index++) {
      if (this.laneOf[index % WINDOW] === laneNumber) this.resend.push(index);
    }
    this.resend.sort((a, b) => a - b);
    this.poke();
  }
}
