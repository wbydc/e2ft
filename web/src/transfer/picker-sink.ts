import type { Bytes } from "../crypto/keys.ts";
import { picker } from "./save.ts";
import type { Sink } from "./sink.ts";

export class PickerSink implements Sink {
  private constructor(
    private readonly handle: FileSystemFileHandle,
    private readonly writable: FileSystemWritableFileStream,
  ) {}

  /** Must be called synchronously inside the click that accepts: the picker needs the user activation. */
  public static async open(name: string): Promise<PickerSink> {
    const handle = await picker()!({ suggestedName: name });

    return new PickerSink(handle, await handle.createWritable());
  }

  public write(chunk: Bytes): Promise<void> {
    return this.writable.write(chunk);
  }

  public close(): Promise<void> {
    return this.writable.close();
  }

  public async abort(): Promise<void> {
    await this.writable.abort().catch(() => {});
    // remove() is Chromium-only; elsewhere the empty file the picker created stays.
    await (this.handle as unknown as { remove?(): Promise<void> }).remove?.().catch(() => {});
  }
}
