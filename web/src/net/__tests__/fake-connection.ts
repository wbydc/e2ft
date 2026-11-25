/** A connection whose first `failures` setLocalDescription calls reject with `error`. */
export class FakeConnection {
  public static failures: Error[] = [];
  public static calls = 0;
  public localDescription: { toJSON(): RTCSessionDescriptionInit } | null = null;

  public createDataChannel() {
    return { readyState: "connecting" };
  }

  public getConfiguration(): RTCConfiguration {
    return { iceServers: [] };
  }

  public async setLocalDescription(): Promise<void> {
    FakeConnection.calls++;
    const error = FakeConnection.failures.shift();
    if (error) throw error;

    this.localDescription = { toJSON: () => ({ type: "offer", sdp: "v=0" }) };
  }

  public close(): void {}
}
