/** A connection that, like Chromium's after a refused description, refuses every setLocalDescription once it has
 *  refused one. The next `refusing.length` connections made each refuse with the next error in turn. */
export class FakeConnection {
  public static refusing: Error[] = [];
  public static made = 0;
  public localDescription: { toJSON(): RTCSessionDescriptionInit } | null = null;
  private readonly error = FakeConnection.refusing.shift();

  public constructor() {
    FakeConnection.made++;
  }

  public createDataChannel() {
    return { readyState: "connecting" };
  }

  public getConfiguration(): RTCConfiguration {
    return { iceServers: [] };
  }

  public async setLocalDescription(): Promise<void> {
    if (this.error) throw this.error;

    this.localDescription = { toJSON: () => ({ type: "offer", sdp: "v=0" }) };
  }

  public close(): void {}
}
