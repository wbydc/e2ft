import type { Bytes } from "../crypto/keys.ts";
import type { Sink } from "./sink.ts";

/** How long the worker gets to receive the frame's `/dl/<id>` request before the download counts as bypassed. */
const FETCH_WAIT_MS = 5_000;

/** Streams the file to a download the Service Worker serves at `/dl/<id>`, one chunk per credit it pulls. */
export class SwSink implements Sink {
  private credits = 0;
  private stopped = false;
  private wake: (() => void) | null = null;
  private ping: ReturnType<typeof setInterval> | undefined;
  private readonly ready: Promise<void>;
  private fetched: () => void = () => {};

  private constructor(
    private readonly port: MessagePort,
    onBrowserCancel: () => void,
  ) {
    this.ready = new Promise<void>((resolve) => {
      port.onmessage = ({ data }) => {
        if (data === "ready") resolve();
        else if (data === "fetched") this.fetched();
        else if (data === "pull") this.credits++;
        else if (data === "cancel") {
          this.stopped = true;
          onBrowserCancel();
        }
        this.wake?.();
        this.wake = null;
      };
    });
  }

  /**
   * `onBrowserCancel` fires when the user cancels the download in the browser's own download UI. Rejects when the
   * frame's request never reaches the worker (the browser sent it to the network), so the caller
   * can save another way.
   */
  public static async open(id: string, name: string, size: number, onBrowserCancel: () => void): Promise<SwSink> {
    const { port1, port2 } = new MessageChannel();
    const sink = new SwSink(port1, onBrowserCancel);
    navigator.serviceWorker.controller!.postMessage({ t: "dl", id, name, size, port: port2 }, [port2]);
    await sink.ready;

    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.src = `/dl/${id}`;
    const fetched = new Promise<boolean>((resolve) => {
      sink.fetched = () => resolve(true);
      setTimeout(() => resolve(false), FETCH_WAIT_MS);
    });
    document.body.append(frame);
    if (!(await fetched)) {
      sink.stop("abort");
      frame.remove();
      throw new Error("the download request bypassed the Service Worker");
    }
    // Port traffic does not count as Service Worker activity; a message event every 10 s keeps it alive.
    sink.ping = setInterval(() => navigator.serviceWorker.controller?.postMessage({ t: "ping" }), 10_000);

    return sink;
  }

  public async write(chunk: Bytes): Promise<void> {
    while (this.credits === 0 && !this.stopped) await new Promise<void>((resolve) => (this.wake = resolve));
    if (this.stopped) return;

    this.credits--;
    this.port.postMessage(chunk.buffer, [chunk.buffer]);
  }

  public async close(): Promise<void> {
    this.stop("done");
  }

  public async abort(): Promise<void> {
    this.stop("abort");
  }

  private stop(message: "done" | "abort"): void {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort, which has no target origin
    if (!this.stopped) this.port.postMessage(message);
    this.stopped = true;
    clearInterval(this.ping);
    this.wake?.();
  }
}
