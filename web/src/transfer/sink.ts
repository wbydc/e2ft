// Where an accepted file is written: the save picker, a Service Worker streamed download,
// or an OPFS file that is downloaded when complete or (iOS) held for the user to save from the history list. All look
// the same to Transfers. save.ts picks which one a browser can use.
import type { Bytes } from "../crypto/keys.ts";

export interface Sink {
  write(chunk: Bytes): Promise<void>;
  close(): Promise<void>;
  /** Discard the partial file where the browser allows it. */
  abort(): Promise<void>;
}
