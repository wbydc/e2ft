// An extra data connection carrying one transfer's chunks: its own RTCPeerConnection with one binary
// channel. Its SDP and ICE travel on the sealed control channel of connection 0, never through the server.
export type LaneSignal = { t: "lane"; d: RTCSessionDescriptionInit } | { t: "lane-ice"; c: RTCIceCandidateInit | null };

export class Lane {
  public readonly channel: RTCDataChannel;
  private readonly connection: RTCPeerConnection;
  private done = false;
  // Signals are applied one at a time, so a candidate never races ahead of its description.
  private tail = Promise.resolve();

  /** `config` is connection 0's, so a shared TURN and forced relay carry over. `closed` fires once when the lane fails
   *  or its channel closes, never after `close()`. */
  constructor(
    config: RTCConfiguration,
    offer: boolean,
    private readonly send: (message: LaneSignal) => void,
    private readonly closed: () => void,
  ) {
    this.connection = new RTCPeerConnection(config);
    this.channel = this.connection.createDataChannel("lane", { negotiated: true, id: 0 });
    this.channel.binaryType = "arraybuffer";

    this.connection.onicecandidate = (e) => send({ t: "lane-ice", c: e.candidate?.toJSON() ?? null });
    // "disconnected" too: a stalled lane holds back the whole file, and its chunks are cheap to resend on the others.
    this.connection.onconnectionstatechange = () =>
      (this.connection.connectionState === "failed" || this.connection.connectionState === "disconnected") &&
      this.end();
    this.channel.onclose = () => this.end();

    if (offer) this.run(() => this.sendLocal());
  }

  public signal(message: LaneSignal): void {
    this.run(async () => {
      if (message.t === "lane-ice") {
        if (message.c) await this.connection.addIceCandidate(message.c);

        return;
      }

      await this.connection.setRemoteDescription(message.d);
      if (message.d.type === "offer") await this.sendLocal();
    });
  }

  public close(): void {
    this.done = true;
    this.connection.close();
  }

  private end(): void {
    if (this.done) return;

    this.done = true;
    this.connection.close();
    this.closed();
  }

  private run(step: () => Promise<void>): void {
    this.tail = this.tail.then(step).catch(() => this.end());
  }

  private async sendLocal(): Promise<void> {
    await this.connection.setLocalDescription();
    this.send({ t: "lane", d: this.connection.localDescription!.toJSON() });
  }
}
