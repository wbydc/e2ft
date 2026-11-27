// WebRTC connection. The creator makes the offer; SDP and ICE travel sealed through signalling, so the relay cannot
// swap DTLS fingerprints. Both sides create the same two negotiated DataChannels: "share" for file chunks and
// "ctl" for control messages, so acks never wait behind chunks.
import type { Role } from "../crypto/keys.ts";
import { isTurnUrl, parseRelay, relayConfig } from "./ice.ts";
import type { Connection } from "./ice.ts";
import { NoRelayError } from "./no-relay-error.ts";
import { parseTurn } from "./settings.ts";
import type { Turn } from "./settings.ts";

type SignalMsg =
  | { t: "sdp"; d: RTCSessionDescriptionInit }
  | { t: "ice"; c: RTCIceCandidateInit | null }
  | ({ t: "turn" } & Turn)
  | { t: "relay"; tcp: boolean };

export interface PeerHandlers {
  open(data: RTCDataChannel, control: RTCDataChannel): void;
  closed(): void;
  fail(err: unknown): void;
  /** Gathering ended with a TURN URL configured but no relay candidate from it: the relay is unreachable. */
  noRelay?(): void;
  /** Joiner: the creator shared its TURN server; `room` is the creator's forced mode, if any. Returns
   *  the config to answer with, or null to keep ours. */
  sharedTurn?(turn: Turn, room: Connection): Promise<RTCConfiguration | null>;
  /** Joiner: the creator's room is relay-only; the config is already switched. */
  relay?(mode: Connection): void;
}

/** A reachable TURN gives a relay candidate within ~2 s, but Chromium ends gathering only after the ~40 s STUN timeout. */
const NO_RELAY_MS = 10_000;

/** Chromium under load can reject a new connection's first offer with an OperationError ("Fingerprint provided but
 *  no identity available"). That connection then refuses every later description with a session error, so the offer
 *  is tried again on a new connection. */
const OFFER_TRIES = 3;
const OFFER_RETRY_MS = 100;

/** The candidate pair the connection uses: `relay` on either side means TURN, `srflx`/`prflx` a punched NAT. */
export interface Route {
  local: RTCIceCandidateType;
  remote: RTCIceCandidateType;
  /** To the TURN server when relayed, else to the other browser. */
  protocol: string;
  rtt?: number;
}

export class Peer {
  private connection: RTCPeerConnection;
  private done = false;
  private sawRelay = false;
  private toldNoRelay = false;
  // One timer per gathering run: whichever of it and gathering complete comes first says the relay is unreachable.
  private noRelayTimer: ReturnType<typeof setTimeout> | undefined;
  // Signals are applied one at a time, so a candidate never races ahead of its description.
  private tail = Promise.resolve();
  // Joiner: the creator's shared TURN and forced mode, held until the offer, when both are known.
  private shared: Turn | null = null;
  private forced: Connection | null = null;

  /** Creator: `share` (its TURN server) and a forced `mode` go to the joiner sealed, before the offer. */
  constructor(
    private readonly role: Role,
    config: RTCConfiguration,
    private readonly send: (message: SignalMsg) => void,
    private readonly on: PeerHandlers,
    share: Turn | null = null,
    mode: Connection = "auto",
  ) {
    this.connection = this.connect(config);

    if (role === "creator") {
      if (share) send({ t: "turn", ...share });
      // After turn: a shared TURN replaces the joiner's config, and relay must apply on top of it.
      if (mode !== "auto") send({ t: "relay", tcp: mode === "tcp" });
      this.offer(config).catch((err) => this.fail(err));
    }
  }

  public handleSignal(message: unknown): void {
    this.tail = this.tail.then(() => this.apply(message)).catch((err) => this.fail(err));
  }

  public async route(): Promise<Route | null> {
    const stats = await this.connection.getStats();
    let pair: any;
    stats.forEach((report) => {
      if (report.type === "transport" && report.selectedCandidatePairId)
        pair = stats.get(report.selectedCandidatePairId);
    });

    // Firefox has no selectedCandidatePairId; it flags the pair instead.
    stats.forEach((report) => {
      if (!pair && report.type === "candidate-pair" && report.selected) pair = report;
    });

    const local = pair && stats.get(pair.localCandidateId);
    const remote = pair && stats.get(pair.remoteCandidateId);
    if (!local || !remote) return null;

    return {
      local: local.candidateType,
      remote: remote.candidateType,
      protocol: local.relayProtocol ?? local.protocol,
      rtt: pair.currentRoundTripTime,
    };
  }

  /** A new RTCPeerConnection with both channels, its events handled while it is this Peer's connection. */
  private connect(config: RTCConfiguration): RTCPeerConnection {
    const connection = new RTCPeerConnection(config);
    const current = () => this.connection === connection;

    connection.onicecandidate = (event) => {
      if (!current()) return;

      if (event.candidate?.type === "relay") {
        this.sawRelay = true;
        this.stopNoRelayTimer();
      }

      this.send({ t: "ice", c: event.candidate?.toJSON() ?? null });
    };
    connection.onicegatheringstatechange = () => {
      if (!current()) return;

      if (connection.iceGatheringState === "gathering") {
        this.startNoRelayTimer();

        return;
      }

      if (connection.iceGatheringState === "complete") this.sayNoRelay();
    };
    connection.onconnectionstatechange = () => {
      if (!current() || connection.connectionState !== "failed") return;

      const noRelay = this.hasTurn() && !this.sawRelay;
      this.fail(noRelay ? new NoRelayError("ICE failed: no relay candidate") : new Error("ICE failed"));
    };

    const data = connection.createDataChannel("share", { ordered: true, negotiated: true, id: 0 });
    const control = connection.createDataChannel("ctl", { ordered: true, negotiated: true, id: 1 });
    let opened = false;

    for (const channel of [data, control]) {
      channel.binaryType = "arraybuffer";

      channel.onopen = () => {
        if (!current() || opened || data.readyState !== "open" || control.readyState !== "open") return;

        opened = true;
        this.on.open(data, control);
      };
      channel.onclose = () => {
        if (!current() || this.done) return;

        this.done = true;
        this.on.closed();
      };
    }

    return connection;
  }

  /** The current config, final once connected: extra data connections reuse it. */
  public config(): RTCConfiguration {
    return this.connection.getConfiguration();
  }

  public close(): void {
    this.stopNoRelayTimer();
    this.done = true;
    this.connection.close();
  }

  /** Creator: nothing has gone to the joiner but `turn` and `relay`, so a refused connection can still be replaced. */
  private async offer(config: RTCConfiguration): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.connection.setLocalDescription();
        break;
      } catch (err) {
        const retryable = err instanceof DOMException && err.name === "OperationError";
        if (!retryable || attempt >= OFFER_TRIES || this.done) throw err;

        await new Promise((resolve) => setTimeout(resolve, OFFER_RETRY_MS * attempt));
        if (this.done) return;

        this.connection.close();
        this.connection = this.connect(config);
      }
    }

    this.send({ t: "sdp", d: this.connection.localDescription!.toJSON() });
  }

  private fail(err: unknown): void {
    if (this.done) return;

    this.done = true;
    this.on.fail(err);
  }

  /** A TURN URL in the current config is what could give this browser a relay candidate. */
  public hasTurn(): boolean {
    return (this.connection.getConfiguration().iceServers ?? []).some((s) => [s.urls].flat().some(isTurnUrl));
  }

  private stopNoRelayTimer(): void {
    clearTimeout(this.noRelayTimer);
    this.noRelayTimer = undefined;
  }

  private sayNoRelay(): void {
    this.stopNoRelayTimer();
    if (this.toldNoRelay || !this.hasTurn() || this.sawRelay) return;

    this.toldNoRelay = true;
    this.on.noRelay?.();
  }

  private startNoRelayTimer(): void {
    this.stopNoRelayTimer();
    this.noRelayTimer = setTimeout(() => this.sayNoRelay(), NO_RELAY_MS);
  }

  /** New servers restart gathering, so candidates seen under the old config do not count. */
  private configure(next: RTCConfiguration): void {
    this.stopNoRelayTimer();
    this.sawRelay = false;
    this.toldNoRelay = false;

    this.connection.setConfiguration(next);
  }

  private async apply(message: unknown): Promise<void> {
    const joinerBeforeOffer = this.role === "joiner" && !this.connection.remoteDescription;
    const signal = message as SignalMsg;

    if (signal?.t === "sdp" && typeof signal.d?.sdp === "string") {
      // The joiner gathers from its answer on, so the config must be final before the offer is applied.
      if (signal.d.type === "offer" && this.shared) {
        const next = await this.on.sharedTurn?.(this.shared, this.forced ?? "auto");
        if (next) this.configure(this.forced ? relayConfig(next.iceServers ?? [], this.forced) : next);
      }

      await this.connection.setRemoteDescription(signal.d);

      if (signal.d.type === "offer") {
        await this.connection.setLocalDescription();
        this.send({ t: "sdp", d: this.connection.localDescription!.toJSON() });
      }
    } else if (signal?.t === "ice") {
      if (signal.c) await this.connection.addIceCandidate(signal.c);
    } else if (signal?.t === "turn") {
      // A late or invalid one is dropped.
      this.shared = joinerBeforeOffer ? parseTurn(signal) : null;
    } else if (signal?.t === "relay") {
      this.forced = joinerBeforeOffer ? parseRelay(signal) : null;
      if (this.forced) {
        this.configure(relayConfig(this.connection.getConfiguration().iceServers ?? [], this.forced));
        this.on.relay?.(this.forced);
      }
    } else {
      throw new Error("unknown signal message");
    }
  }
}
