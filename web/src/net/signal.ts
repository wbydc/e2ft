// Signalling over /ws. Text frames are the server's room events; binary frames are peer messages the server relays
// without being able to read them (wire protocol: docs/protocol.md). On the first pairing the two sides
// run CPace over the relay to turn the short secret into the room key; every later binary frame is sealed.
// A dropped socket rejoins the same seat with this page's token until the server refuses.
import { compareCode, randomKey, roomCrypto } from "../crypto/keys.ts";
import { Sealer } from "../crypto/sealer.ts";
import type { Bytes, Role, RoomCrypto } from "../crypto/keys.ts";
import { lvCat } from "../crypto/cpace.ts";
import type { Ristretto } from "../crypto/cpace.ts";
import { KeyExchange, commitTo, opensCommitment } from "../crypto/key-exchange.ts";

export type ServerEvent =
  | { t: "created" }
  | {
      t: "joined" | "peer-joined" | "peer-back" | "rejoined";
      iceServers: RTCIceServer[];
      gen: number;
      keepAlive: number;
    }
  | { t: "rejoined" }
  | { t: "peer-away"; wait: number }
  | { t: "peer-left" }
  | { t: "error"; e: string }
  | { t: "ice"; iceServers: RTCIceServer[] };

export interface SignalHandlers {
  server(event: ServerEvent): void;
  message(message: unknown): void;
  /** CPace confirmed: the room keys, given once, before the pairing event that waited for them. */
  keyed(room: RoomCrypto): void;
  /** A discovered room's keys exist: show `code` and resolve with whether the user says it matches the other
   *  screen. On false call leave(). */
  compare(code: string): Promise<boolean>;
  /** The peer proved a different secret (or none). Call leave() after it. */
  wrongKey(): void;
  /** A sealed frame failed to open, or a key exchange was cut off after our tag went out. Call leave() after it. */
  fail(err: unknown): void;
  /** Our socket dropped after the room was set up; a rejoin is under way. */
  reconnecting(): void;
  /** The server could not be reached at all, or not again within the longest keep-alive. */
  closed(): void;
}

/** How long a new connection waits for fresh ICE servers before it opens with the pairing's. */
const ICE_WAIT_MS = 2000;

/** Longest keep-alive: past it no rejoin can succeed. */
const GIVE_UP_MS = 30 * 60_000;

// A separate file loaded only when a room starts; the server adds its content hash to this URL (src/assets.rs).
const RISTRETTO_URL: string = "/ristretto.js";
let ristrettoLoad: Promise<Ristretto> | undefined;
const loadRistretto = () => (ristrettoLoad ??= import(RISTRETTO_URL) as Promise<Ristretto>);

/** One CPace run, tied to the pairing (gen) it started in, holding back that pairing's server event. */
interface Pake {
  gen: number;
  held: ServerEvent;
  exchange: Promise<KeyExchange>;
  /** Our tag went out: from then on the peer may have tested one guess of the secret. */
  tagOut?: true;
  /** Discovered room: our share went out against the peer's commitment or share. A relay that could restart the
   *  run from here would collect fresh shares until the two compared codes match, so the room ends instead. */
  shareOut?: true;
  /** Discovered room, joiner: the creator's commitment, which its share must open. */
  commitment?: Uint8Array;
}

/** A discovered room between its keys and both sides saying the codes match; holds back the pairing event. */
interface Check {
  held: ServerEvent;
  mine: boolean;
  theirs: boolean;
}

/** What a discovered room uses as the CPace password: public, so the exchange proves nothing by itself and the
 *  compared code does the proving. */
const DISCOVERED_PRS = "discovered";

export class Signal {
  private readonly keepAlive: number | undefined;
  private readonly token = randomKey();
  private readonly ci: Bytes;
  private seated = false;
  private dead = false;
  private socket!: WebSocket;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private lostAt = 0;
  // One sealed stream per pairing; frames of any other pairing are dropped unopened.
  private gen = -1;
  /** The highest pairing seen, kept across reconnects: the server bumps `gen` on every pairing, so a lower or equal
   *  one is a replay of an earlier pairing's frames, which only a malicious server sends. */
  private maxGen = -1;
  private keys: RoomCrypto | null = null;
  private sealer: Sealer | null = null;
  private pake: Pake | null = null;
  private check: Check | null = null;
  private readonly secret: string;
  /** A discovered room: no secret, so the creator commits to its share and both screens compare a code. */
  private readonly discovered: boolean;
  // Every inbound frame, text or binary, is handled in arrival order, so a CPace step that awaits crypto finishes
  // before the next frame (a sealed message, or the peer's leave after a wrong key) is looked at.
  private inbox: Promise<unknown> = Promise.resolve();
  /** Callers waiting for fresh ICE servers; one answer serves them all. */
  private iceWaiters: ((servers: RTCIceServer[] | null) => void)[] = [];

  constructor(
    private readonly role: Role,
    private readonly room: string,
    secret: string | null,
    private readonly on: SignalHandlers,
    opts: { keepAlive?: number } = {},
  ) {
    this.keepAlive = opts.keepAlive;
    this.discovered = secret === null;
    this.secret = secret ?? DISCOVERED_PRS;
    this.ci = lvCat(new TextEncoder().encode("e2ft/v1"), new TextEncoder().encode(room));
    void loadRistretto();
    this.open();
  }

  public send(message: unknown): void {
    // Snapshots: the frame goes out tagged with the pairing it was sealed for, even if a new one starts meanwhile.
    const gen = this.gen;
    const sealer = this.sealer;
    if (!sealer) return;

    void sealer.seal(message).then((b) => this.sendFrame(gen, b));
  }

  /** Fresh ICE servers from the server for a new connection in this pairing; null when it does not answer in time. */
  public ice(): Promise<RTCIceServer[] | null> {
    if (this.gen < 0 || this.socket.readyState !== WebSocket.OPEN) return Promise.resolve(null);

    return new Promise((resolve) => {
      const done = (servers: RTCIceServer[] | null) => {
        clearTimeout(timer);
        this.iceWaiters = this.iceWaiters.filter((waiter) => waiter !== done);
        resolve(servers);
      };
      const timer = setTimeout(() => done(null), ICE_WAIT_MS);
      this.iceWaiters.push(done);
      this.socket.send(JSON.stringify({ t: "ice" }));
    });
  }

  /** Replaces the socket with a fresh one that rejoins our seat (the old one may be dead without knowing it). */
  public reconnect(): void {
    if (this.dead || !this.seated) return;

    this.socket.onclose = null;
    this.socket.close();
    this.attempt = 0;
    this.lost();
  }

  /** Deletes the room on the server, then closes. */
  public leave(): void {
    this.dead = true;
    clearTimeout(this.retry);
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ t: "leave" }));
    this.socket.close();
  }

  private hello() {
    const seat = { room: this.room, token: this.token };
    if (this.seated) return { t: "rejoin", ...seat, role: this.role };
    if (this.role === "joiner") return { t: "join", ...seat };

    return { t: "create", ...seat, ...(this.keepAlive !== undefined && { keepAlive: this.keepAlive }) };
  }

  private die(err: unknown): void {
    if (this.dead) return;

    this.dead = true;
    this.on.fail(err);
  }

  private sendFrame(gen: number, payload: Uint8Array): void {
    if (gen !== this.gen || this.socket.readyState !== WebSocket.OPEN) return;

    const out = new Uint8Array(4 + payload.byteLength);
    new DataView(out.buffer).setUint32(0, gen);
    out.set(payload, 4);
    this.socket.send(out);
  }

  /** A run that ends before both tags check out. Once our tag is out, a peer that saw it may have tested one guess
   *  of the secret, so the room ends instead of offering a fresh run, keeping one guess per room. A
   *  discovered room whose codes were not both confirmed ends too: its next pairing would start unverified. */
  private abandonPake(): void {
    const cutOff = this.pake?.tagOut || this.pake?.shareOut || this.check;
    this.pake = null;
    this.check = null;
    if (cutOff) this.die(new Error("key exchange cut off"));
  }

  private startPake(event: ServerEvent): void {
    this.abandonPake();
    if (this.dead) return;

    const pake: Pake = {
      gen: this.gen,
      held: event,
      exchange: loadRistretto().then((ristretto) => KeyExchange.start(ristretto, this.role, this.secret, this.ci)),
    };
    this.pake = pake;
    pake.exchange
      .then(async (exchange) => {
        // Discovered: the creator sends a commitment first, the joiner nothing until it has it.
        if (this.discovered && this.role === "joiner") return;

        const first = this.discovered ? await commitTo(exchange.share) : exchange.share;
        if (this.pake === pake) this.sendFrame(pake.gen, first);
      })
      .catch((err) => this.die(err));
  }

  private async onPakeFrame(pake: Pake, data: Uint8Array): Promise<void> {
    const exchange = await pake.exchange;
    if (this.discovered && this.role === "joiner" && !pake.commitment) {
      pake.commitment = data;
      pake.shareOut = true;
      this.sendFrame(pake.gen, exchange.share);

      return;
    }

    if (!pake.tagOut) {
      if (pake.commitment && !(await opensCommitment(pake.commitment, data))) {
        if (this.pake === pake) this.die(new Error("share does not open the commitment"));

        return;
      }
      // The creator reveals its share only now, with the joiner's share in hand.
      if (this.discovered && this.role === "creator" && this.pake === pake) {
        pake.shareOut = true;
        this.sendFrame(pake.gen, exchange.share);
      }

      const tag = await exchange.receive(data);
      if (this.pake !== pake) return;
      if (!tag) return this.wrongKey();
      pake.tagOut = true;
      this.sendFrame(pake.gen, tag);

      return;
    }

    const isk = await exchange.verify(data);
    if (this.pake !== pake) return;
    if (!isk) return this.wrongKey();
    this.keys = await roomCrypto(this.room, isk);
    this.pake = null;
    if (this.dead || pake.gen !== this.gen) return;

    this.sealer = new Sealer(this.keys.signal, `sig/${this.gen}`, this.role);
    if (!this.discovered) return this.release(pake.held);

    const check: Check = { held: pake.held, mine: false, theirs: false };
    this.check = check;
    const code = await compareCode(this.keys);
    if (this.check !== check || this.dead) return;

    void this.on.compare(code).then((matches) => {
      if (!matches || this.check !== check || this.dead) return;

      check.mine = true;
      this.send({ t: "match" });
      this.settle(check);
    });
  }

  /** The room is keyed and, if discovered, confirmed by both: the pairing event that waited goes to the room. */
  private release(held: ServerEvent): void {
    this.on.keyed(this.keys!);
    this.on.server(held);
  }

  private settle(check: Check): void {
    if (!check.mine || !check.theirs) return;

    this.check = null;
    this.release(check.held);
  }

  /** A sealed message. Until both sides confirmed the code, the only one allowed is the peer's `match`. */
  private onMessage(message: unknown): void {
    const check = this.check;
    if (!check) return this.on.message(message);
    if ((message as { t?: unknown } | null)?.t !== "match")
      return this.die(new Error("message before the code matched"));

    check.theirs = true;
    this.settle(check);
  }

  private wrongKey(): void {
    this.pake = null;
    if (this.dead) return;

    this.dead = true;
    this.on.wrongKey();
  }

  private onBinary(data: Bytes): Promise<void> | void {
    // Snapshot: the async open below must still match the live pairing when it resolves.
    const gen = this.gen;
    if (data.byteLength < 4 || new DataView(data.buffer).getUint32(0) !== gen) return;

    const payload = data.subarray(4);
    if (this.pake?.gen === gen) return this.onPakeFrame(this.pake, payload);
    if (!this.sealer) return;

    // Sealer.open resolves in arrival order, so handlers run in order too; it is not awaited here.
    this.sealer.open(payload).then(
      (m) => !this.dead && gen === this.gen && this.onMessage(m),
      (err) => !this.dead && gen === this.gen && this.die(err),
    );
  }

  private open(): void {
    const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    this.socket = sock;
    sock.binaryType = "arraybuffer";

    sock.onopen = () => sock.send(JSON.stringify(this.hello()));
    sock.onmessage = (event) => {
      const data = event.data as string | ArrayBuffer;
      this.inbox = this.inbox
        .then(() => {
          if (this.dead || sock !== this.socket) return;

          return typeof data === "string"
            ? this.onText(JSON.parse(data) as ServerEvent)
            : this.onBinary(new Uint8Array(data));
        })
        .catch((err) => this.die(err));
    };
    sock.onclose = () => {
      if (this.dead || sock !== this.socket) return;

      if (!this.seated) {
        this.dead = true;
        this.on.closed();

        return;
      }

      this.lost();
    };
  }

  private onText(event: ServerEvent): void {
    if (event.t === "ice") {
      for (const waiter of this.iceWaiters) waiter(event.iceServers);

      return;
    }

    if (event.t === "created" || event.t === "joined" || event.t === "rejoined") {
      this.seated = true;
      this.attempt = 0;
    }
    if (event.t === "peer-away") this.abandonPake();
    if (event.t === "peer-left" || event.t === "error") this.dead = true;

    if ("gen" in event && typeof event.gen === "number") {
      if (event.gen <= this.maxGen) throw new Error("the server repeated an earlier pairing");

      this.gen = this.maxGen = event.gen;
      if (!this.keys) return this.startPake(event);

      // A new pairing while the code was still being compared would start unverified.
      this.abandonPake();
      if (this.dead) return;

      this.sealer = new Sealer(this.keys.signal, `sig/${this.gen}`, this.role);
    }

    this.on.server(event);
  }

  private lost(): void {
    this.gen = -1;
    this.sealer = null;
    this.abandonPake();
    if (this.dead) return;

    if (!this.attempt) this.lostAt = Date.now();
    if (Date.now() - this.lostAt > GIVE_UP_MS) {
      this.dead = true;
      this.on.closed();

      return;
    }

    this.on.reconnecting();
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.open(), this.attempt ? Math.min(1000 * 2 ** this.attempt, 10_000) : 0);
    this.attempt++;
  }
}
