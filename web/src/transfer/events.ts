// What Transfers tells the room page: an offer to answer, status lines, progress per direction, and how each
// transfer ended.
import type { Text } from "../i18n/index.ts";
import type { Sink } from "./sink.ts";
import type { Offer } from "./wire.ts";

export type Dir = "out" | "in";

export interface Progress {
  name: string;
  done: number;
  total: number;
  /** The sender waits for the receiver's answer; Fun mode keeps its beam still until then. */
  waiting?: boolean;
  /** The connection dropped; the transfer waits for the next one. */
  paused?: boolean;
}

export type Outcome = "done" | "declined" | "cancelled" | "failed";

/** One per offer, when it ends either way. */
export interface Finished {
  id: string;
  dir: Dir;
  name: string;
  size: number;
  type: string;
  outcome: Outcome;
}

export type FileInfo = Omit<Finished, "dir" | "outcome">;

export interface TransferHooks {
  /** Ask the user; resolve with where to write, or null to decline. */
  offer(offer: Offer): Promise<Sink | null>;
  /** The sender withdrew an offer that is still waiting for an answer. */
  offerCancelled(offer: Offer): void;
  /** `waiting` while the sender waits for the peer to accept; every other status clears the waiting glyph. */
  status(text: Text, kind: "info" | "success" | "warning" | "danger", waiting?: boolean): void;
  progress(dir: Dir, progress: Progress | null): void;
  finished(finished: Finished): void;
  fail(err: unknown): void;
}
