import { randomKey, type Bytes } from "../crypto/keys.ts";
import { opfsDir } from "./save.ts";
import type { Sink } from "./sink.ts";

/** An OPFS file under a local random name (`file`), never one the peer picks; downloaded once complete, or with
 *  `hold` kept for `heldFile`. */
export class OpfsSink implements Sink {
  private constructor(
    private readonly dir: FileSystemDirectoryHandle,
    private readonly handle: FileSystemFileHandle,
    private readonly writable: FileSystemWritableFileStream,
    public readonly file: string,
    private readonly name: string,
    private readonly hold: boolean,
  ) {}

  public static async open(name: string, hold = false): Promise<OpfsSink> {
    const dir = await opfsDir(true);
    const file = randomKey();
    const handle = await dir.getFileHandle(file, { create: true });

    return new OpfsSink(dir, handle, await handle.createWritable(), file, name, hold);
  }

  public write(chunk: Bytes): Promise<void> {
    return this.writable.write(chunk);
  }

  public async close(): Promise<void> {
    await this.writable.close();
    if (this.hold) return;

    // shortcut: the object URL is never revoked and the file stays in OPFS until a visit an hour later;
    // revoke and delete on download completion if storage use becomes a problem.
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(await this.handle.getFile());
    anchor.download = this.name;
    anchor.click();
  }

  public async abort(): Promise<void> {
    await this.writable.abort().catch(() => {});
    await this.dir.removeEntry(this.file).catch(() => {});
  }
}
