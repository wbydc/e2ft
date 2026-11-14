/** A WebSocket the test plays the server for: `serverSays` delivers a text frame. */
export class FakeSocket {
  public static readonly OPEN = 1;
  public static opened: FakeSocket[] = [];
  public readyState = FakeSocket.OPEN;
  public binaryType = "";
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  public onclose: (() => void) | null = null;

  public constructor() {
    FakeSocket.opened.push(this);
  }

  public send(): void {}

  public close(): void {}

  public serverSays(event: object): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}
