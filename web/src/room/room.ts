// One room from start to end: signalling, the peer connection of each pairing, the room's one Transfers, the
// wake lock, and the page events that end, wake or reseat it. A page holds one Room: an ended room goes home by
// navigation, so a Room is never reset or reused.
import type { Invite } from "../crypto/invite.ts";
import type { Role, RoomCrypto } from "../crypto/keys.ts";
import { translate } from "../i18n/index.ts";
import type { Text } from "../i18n/index.ts";
import { iceServers, relayConfig, withFreshTurn } from "../net/ice.ts";
import type { Connection } from "../net/ice.ts";
import { NoRelayError } from "../net/no-relay-error.ts";
import { Peer } from "../net/peer.ts";
import type { RoomSettings, Turn } from "../net/settings.ts";
import { Signal } from "../net/signal.ts";
import type { ServerEvent } from "../net/signal.ts";
import type { Dir, Progress } from "../transfer/events.ts";
import { Transfers } from "../transfer/transfers.ts";
import type { LanePlan } from "../transfer/lanes.ts";
import type { SwitchAnswer } from "../transfer/wire.ts";
import { notify } from "../ui/notify.ts";
import { setupConnInfo } from "../ui/room/conn.ts";
import { addHistory } from "../ui/room/history.ts";
import { askCompare, closeCompare } from "../ui/room/compare.ts";
import { askOffer, closeOffer } from "../ui/room/offer.ts";
import { flourish, showProgress } from "../ui/room/progress.ts";
import { askSwitch, closeSwitch, showSlowCard, wireSlowCard } from "../ui/room/switch.ts";
import {
  askUseShared,
  hidePaired,
  setConnected,
  setSendable,
  showEnded,
  showPaired,
  showRoomInfo,
  showRoomScreen,
  showSending,
  wireRoomControls,
} from "../ui/room/view.ts";
import { defuseCountdown, setPresence, setStatus, showAway, stopAway } from "../ui/status.ts";
import type { Kind, Presence } from "../ui/status.ts";
import { ERRORS, LATE_ERRORS, NOTIFY_TITLE, RELAY_DOWN } from "./messages.ts";
import type { RelayBy } from "./messages.ts";
import { SlowWatch } from "./slow-watch.ts";

/** `?relay=1` forces this browser through TURN, like a Relay room without telling the other side. */
export const RELAY_ONLY = new URLSearchParams(location.search).has("relay");

/** `?lanes=N` (1-8) sends each file on N data connections from the start, never adapting: `?lanes=1` is the
 *  one-connection baseline for speed comparisons. */
const lanesParam = Number(new URLSearchParams(location.search).get("lanes"));
const LANES = Number.isInteger(lanesParam) && lanesParam >= 1 && lanesParam <= 8 ? lanesParam : null;

/** `?slow=1` suggests Relay over TCP as soon as a transfer runs, slow or not, so the switch can be tried on a fast
 *  network. */
const FORCE_SLOW = new URLSearchParams(location.search).has("slow");

/** What the page that accepted a discovered ask learns about the room it creates. */
export type DiscoveredHooks = { created(): void; ended(): void };

export class Room {
  private readonly signal: Signal;
  private peer: Peer | undefined;
  /** One per room, made on the first connection: each new connection resumes what the last one left paused. */
  private transfers: Transfers | undefined;
  /** Set by the key exchange before the first pairing event reaches connectPeer. */
  private keys: RoomCrypto | undefined;
  private ended = false;
  /** The room was set up on the server, so a refused hello now means it is gone. */
  private seated = false;
  /** Bumped whenever the peer connection is replaced, so callbacks of an old one do nothing. */
  private pairing = 0;
  /** The next open connection is the peer joining or coming back, not a reconnect after a drop. */
  private announce = false;
  /** A discovered room whose code is not yet confirmed by both: the peer leaving now means it did not confirm. */
  private comparing = false;
  /** Joiner: whether to relay through the creator's shared TURN server, asked once per room. */
  private useShared: Promise<boolean> | undefined;
  private wakeLock: WakeLockSentinel | null = null;
  private readonly ownRelay: RelayBy;
  private readonly slowWatch = new SlowWatch();
  /** The Relay over TCP suggestion: watching transfers, on the card, asked of the peer, the peer's ask on screen, or
   *  over for this room (switched, dismissed or declined), reconnects included. */
  private slow: "watching" | "shown" | "asked" | "deciding" | "over" = "watching";

  /** `invite` is null in a discovered room, which has no secret: both screens compare a code instead, and
   *  `hooks.created` tells the creating page its room exists, so it can pass `accessKey` on; `hooks.ended` that
   *  the room ended, whether or not it was created.
   *  A creator's `invite` is `Invite.create()` from the same `settings` and `connection`, so its hints match the room.
   *  `settings` is copied when the room starts: later edits to the defaults do not change it. `connection` is
   *  the creator's custom-room choice; a joiner learns it from the creator. Both sides set it to tcp when they
   *  agree to switch a slow room. `useShared` is the joiner's answer on the Join screen when the invite announced a
   *  shared TURN. */
  private constructor(
    private readonly role: Role,
    accessKey: string,
    private readonly invite: Invite | null,
    private readonly settings: RoomSettings,
    private connection: Connection,
    useShared: boolean | undefined,
    private readonly hooks?: DiscoveredHooks,
  ) {
    showRoomScreen(role, invite, settings.hideQr);
    setStatus(role === "creator" ? (m) => m.creating : (m) => m.joining);
    this.ownRelay = settings.turn ? "own" : "ours";
    if (role === "creator") showRoomInfo(settings.keepAlive, this.ownRelay, connection);

    this.useShared = role === "joiner" && useShared !== undefined ? Promise.resolve(useShared) : undefined;
    this.signal = new Signal(
      role,
      accessKey,
      invite && invite.secret,
      {
        server: (event) => this.onServer(event),
        message: (message) => this.peer?.handleSignal(message),
        keyed: (keys) => {
          this.keys = keys;
          this.comparing = false;
        },
        compare: (code) => this.compare(code),
        wrongKey: () => this.end((m) => m.wrongKey, "danger"),
        fail: () => this.end((m) => m.notVerified, "danger"),
        reconnecting: () => this.dropPeer((m) => m.reconnecting, "warning", "plug"),
        closed: () => this.end((m) => m.serverLost, "danger"),
      },
      { keepAlive: settings.keepAlive },
    );
    this.listen();
  }

  /** This browser's connection mode: the room's, or relay when forced here (`?relay=1`, Always relay). */
  private get mode(): Connection {
    return this.connection === "auto" && (RELAY_ONLY || this.settings.alwaysTurn) ? "relay" : this.connection;
  }

  public static start(
    role: Role,
    invite: Invite,
    settings: RoomSettings,
    connection: Connection = "auto",
    useShared?: boolean,
  ): Room {
    return new Room(role, invite.accessKey, invite, settings, connection, useShared);
  }

  /** A room between two devices that found each other on one network: no invite, a compared code instead. */
  public static discovered(role: Role, accessKey: string, settings: RoomSettings, hooks?: DiscoveredHooks): Room {
    return new Room(role, accessKey, null, settings, "auto", undefined, hooks);
  }

  private async compare(code: string): Promise<boolean> {
    this.comparing = true;
    const matches = await askCompare(code);
    if (!matches) this.end((m) => m.codeMismatch, "danger");

    return matches;
  }

  /** The room screen's controls and the page lifecycle events that end, wake or reseat the room. */
  private listen(): void {
    setupConnInfo(
      () => this.peer?.route(),
      () => this.transfers?.lanes ?? { out: 0, in: 0 },
    );
    wireRoomControls({
      send: (file) => void this.sendFile(file),
      cancel: (dir) => this.transfers?.cancel(dir),
      leave: () => this.end((m) => m.youLeft, "info"),
    });
    wireSlowCard({ switch: () => this.askSwitch(), dismiss: () => this.dismissSlow() });

    // A page put in the back/forward cache may come back, so its pagehide does not leave.
    window.addEventListener("pagehide", (event) => !event.persisted && this.end((m) => m.youLeft, "info"));
    // Firefox closes the page's sockets before pagehide on a navigation, so the leave goes out here.
    window.addEventListener("beforeunload", () => this.end((m) => m.youLeft, "info"));

    let hiddenAt = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();

        return;
      }
      if (this.ended) return;

      if (this.transfers?.connected) void this.keepAwake();
      // After a suspend the socket can look open and be dead: take the seat again on a fresh one.
      else if (Date.now() - hiddenAt > 1000) this.signal.reconnect();
    });
  }

  private onServer(event: ServerEvent): void {
    switch (event.t) {
      case "created":
        this.seated = true;
        setStatus(this.invite ? (m) => m.roomReady : (m) => m.roomReadyDiscovered, "info", "waiting");
        this.hooks?.created();
        break;
      case "joined":
      case "peer-joined":
      case "peer-back":
        this.seated = true;
        this.announce = true;
        this.connectPeer(event.iceServers, event.keepAlive);
        break;
      case "rejoined":
        this.announce = false;
        if ("iceServers" in event) this.connectPeer(event.iceServers, event.keepAlive);
        else if (this.role === "creator") this.dropPeer((m) => m.roomReady, "info", "waiting");
        break;
      case "peer-away":
        this.seated = true;
        this.dropPeer((m) => m.peerAway(""), "warning");
        showAway(event.wait);
        break;
      case "peer-left":
        this.end(this.comparing ? (m) => m.codeUnconfirmed : (m) => m.peerLeft, "warning");
        break;
      case "error":
        this.end(
          this.seated ? (LATE_ERRORS[event.e] ?? ((m) => m.roomGone)) : (ERRORS[event.e] ?? ((m) => m.roomRefused)),
          "danger",
        );
    }
  }

  /** A new pairing: replace the peer connection with one built from the server's ICE servers. */
  private connectPeer(fromServer: RTCIceServer[], keepAlive: number): void {
    let relayBy = this.ownRelay;
    const info = () => showRoomInfo(keepAlive, relayBy, this.connection);
    info();
    this.dropPeer((m) => m.connecting, "info", "defuse");

    const pairing = this.pairing;
    let opened = false;
    // The connection dropped after it worked: rejoin, so the server pairs us again. The pause lets a peer-left
    // that is on its way win, so a Leave on the other side reads "left", not "room gone".
    const lost = () => {
      if (this.pairing !== pairing) return;

      this.dropPeer((m) => m.reconnecting, "warning", "plug");
      const now = this.pairing;
      setTimeout(() => !this.ended && this.pairing === now && this.signal.reconnect(), 1500);
    };

    // The shared credential lives only in this closure and the peer connection config.
    const sharedTurn = async (turn: Turn, roomConnection: Connection) => {
      // The creator's TURN would see this browser's IP: ask wherever the joiner expects privacy.
      const shouldAsk = !!this.settings.turn || this.mode !== "auto" || roomConnection !== "auto";
      const approved = await (this.useShared ??= shouldAsk
        ? askUseShared(!!this.settings.turn)
        : Promise.resolve(true));
      if (!approved || this.pairing !== pairing) return null;

      relayBy = "theirs";
      info();

      return relayConfig(iceServers(turn, fromServer), this.mode);
    };
    // Only a room that cannot go direct ends the moment the relay is known to be unreachable; Auto waits for ICE.
    const relayOnly = () => this.mode !== "auto";
    const relayDown = () => RELAY_DOWN[relayBy][relayOnly() ? "only" : "auto"];

    this.peer = new Peer(
      this.role,
      relayConfig(iceServers(this.settings.turn, fromServer), this.mode),
      (message) => this.signal.send(message),
      {
        sharedTurn,
        relay: (forced) => {
          if (this.pairing !== pairing) return;

          this.connection = forced;
          info();
        },
        noRelay: () => {
          if (this.pairing !== pairing) return;

          if (relayOnly()) this.end(relayDown(), "danger");
        },
        open: (data, control) => {
          if (this.pairing !== pairing) return;

          opened = true;
          this.paired(this.peer!, data, control, fromServer);
        },
        closed: lost,
        fail: (err) =>
          opened
            ? lost()
            : this.pairing === pairing &&
              this.end(err instanceof NoRelayError ? relayDown() : (m) => m.noConnection, "danger"),
      },
      this.role === "creator" && this.settings.shareTurn ? this.settings.turn : null,
      this.role === "creator" ? this.connection : "auto",
    );
  }

  /** The peer connection opened: transfers run on it, and the room screen shows the peer is in. */
  private paired(peer: Peer, data: RTCDataChannel, control: RTCDataChannel, fromServer: RTCIceServer[]): void {
    // Relayed when either side's end of connection 0's selected pair is a TURN relay.
    const plan = async (): Promise<LanePlan> => {
      const route = await peer.route();
      const relayed = !route || route.local === "relay" || route.remote === "relay";
      if (!relayed) return { config: peer.config(), relayed };

      // The pairing's TURN username may have expired: coturn refuses it on a new connection's first allocation.
      const fresh = await this.signal.ice();

      return { config: fresh ? withFreshTurn(peer.config(), fromServer, fresh) : peer.config(), relayed };
    };
    const transfers = (this.transfers ??= this.createTransfers());
    transfers.attach(data, control, plan);

    setConnected(true);
    // A paused file still going out keeps new ones off until it resumes or is cancelled.
    if (transfers.busy) setSendable(false);
    void this.keepAwake();
    showPaired();

    if (this.announce) {
      void notify(
        translate((m) => m.notifyPeerJoined),
        translate((m) => m.notifyPeerJoinedBody),
        "peer",
      );
    }
    this.announce = false;
  }

  private createTransfers(): Transfers {
    return new Transfers(
      this.keys!,
      this.role,
      {
        offer: (offer) => askOffer(offer, () => this.transfers?.cancel("in")),
        offerCancelled: () => closeOffer("withdrawn"),
        status: (text, kind, waiting) => setStatus(text, kind, waiting ? "waiting" : null),
        progress: (dir, progress) => {
          showProgress(dir, progress);
          this.watchSlow(dir, progress);
        },
        finished: (finished) => {
          addHistory(finished);
          flourish(finished);
          void notify(translate(NOTIFY_TITLE[finished.dir][finished.outcome]), finished.name, finished.id);
        },
        switchTcp: (answer) => void this.peerSwitch(answer),
        fail: () => this.end((m) => m.transferFailed, "danger"),
      },
      LANES,
    );
  }

  /** The peer connection is gone, the room maybe not: running transfers pause, the drop area goes.
   *  `presence` says which Fun mode glyph the new state keeps up ("defuse" keeps the countdown for its burst). */
  private dropPeer(text: Text, kind: Kind, presence: Presence | "defuse" = null): void {
    if (this.ended) return;

    this.pairing++;
    const wasCountdown = stopAway();
    this.transfers?.detach();
    this.peer?.close();
    this.peer = undefined;

    hidePaired();
    closeOffer("decline");
    closeSwitch();
    setStatus(text, kind);
    if (presence === "defuse") {
      if (wasCountdown) defuseCountdown();
    } else setPresence(presence);
  }

  private end(text: Text, kind: Kind): void {
    if (this.ended) return;

    this.dropPeer(text, kind);
    this.transfers?.abort();
    this.ended = true;
    this.signal.leave();
    closeCompare();
    showSlowCard(false);

    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    showEnded(kind);
    this.hooks?.ended();
  }

  /** Shows the Relay over TCP suggestion once a transfer has crawled long enough, unless this room is past it. */
  private watchSlow(dir: Dir, progress: Progress | null): void {
    const eligible = this.slow === "watching" && this.connection !== "tcp" && !!this.peer?.hasTurn();
    const lanes = this.transfers?.lanes[dir] ?? 0;
    const slow = this.slowWatch.sample(dir, progress, lanes, performance.now(), eligible);
    if (!slow && !(FORCE_SLOW && eligible && progress && !progress.paused)) return;

    this.slow = "shown";
    showSlowCard(true);
  }

  /** The card's Switch: ask the peer, who has to accept, since relaying shows both IP addresses to the TURN server. */
  private askSwitch(): void {
    if (this.slow !== "shown" || !this.transfers?.connected) return;

    this.slow = "asked";
    showSlowCard(false);
    this.transfers.sendSwitch("ask");
    setStatus((m) => m.switchAsked, "info", "waiting");
  }

  private dismissSlow(): void {
    this.slow = "over";
    showSlowCard(false);
  }

  private async peerSwitch(answer: SwitchAnswer): Promise<void> {
    if (answer !== "ask") {
      if (this.slow !== "asked") return;

      if (answer === "yes") this.switchToTcp(true);
      else {
        this.slow = "over";
        setStatus((m) => m.switchDeclined, "info");
      }

      return;
    }

    // Both asked at once: both switch, and only the creator takes its seat again.
    if (this.slow === "asked") return this.switchToTcp(this.role === "creator");
    if (this.slow === "deciding" || this.connection === "tcp") return;
    if (!this.peer?.hasTurn()) return this.transfers?.sendSwitch("no");

    this.slow = "deciding";
    showSlowCard(false);
    const accepted = await askSwitch();
    if (this.slow !== "deciding") return;

    if (!accepted) {
      this.slow = "over";
      this.transfers?.sendSwitch("no");

      return;
    }

    this.transfers?.sendSwitch("yes");
    this.switchToTcp(false);
  }

  /** Both sides set the room to Relay over TCP; the one that `reconnects` takes its seat again, which pairs both
   *  anew on relay-only TCP connections, and running transfers resume from where they paused. Restarting ICE on
   *  the open connection is not enough: Chromium keeps using the direct pair it already has. */
  private switchToTcp(reconnects: boolean): void {
    this.slow = "over";
    this.connection = "tcp";
    showSlowCard(false);
    setStatus((m) => m.switching, "info", "waiting");
    if (!reconnects) return;

    this.dropPeer((m) => m.switching, "info", "plug");
    this.signal.reconnect();
  }

  private async sendFile(file: File | undefined): Promise<void> {
    const transfers = this.transfers;
    if (!file || !transfers?.connected || this.ended) return;

    if (transfers.busy) {
      setStatus((m) => m.busy, "warning");

      return;
    }

    showSending();
    try {
      await transfers.sendFile(file);
    } catch {
      this.end((m) => m.sendFailed, "danger");
    } finally {
      // Ended while disconnected (cancelled while paused): the next connection's open turns sending back on.
      if (!this.ended && transfers.connected) setSendable(true);
    }
  }

  /** Keeps the screen on while in a room: a locked phone suspends the page and drops the connection. */
  private async keepAwake(): Promise<void> {
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {}
  }
}
