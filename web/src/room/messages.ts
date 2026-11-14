// The room's text tables: why the server refused, why a relay failed, and notification titles.
import type { Text } from "../i18n/index.ts";
import type { Dir, Outcome } from "../transfer/events.ts";

/** The server's refusal codes before the room was set up. */
export const ERRORS: Record<string, Text> = {
  "not-found": (m) => m.roomNotFound,
  full: (m) => m.roomFull,
  exists: (m) => m.roomExists,
  busy: (m) => m.roomBusy,
  "too-many": (m) => m.roomTooMany,
};

/** The server's codes for ending a room that was set up; any other reads as the room being gone. */
export const LATE_ERRORS: Record<string, Text> = {
  unjoined: (m) => m.roomUnjoined,
  rate: (m) => m.roomRate,
  "too-many": (m) => m.roomTooMany,
};

export type RelayBy = "ours" | "own" | "theirs";

/** The relay this browser needed gave no candidate: said by role, with a direct-connection clause only when one
 *  was tried. */
export const RELAY_DOWN: Record<RelayBy, { auto: Text; only: Text }> = {
  ours: { auto: (m) => m.relayDownOurs, only: (m) => m.relayDownOursOnly },
  own: { auto: (m) => m.relayDownOwn, only: (m) => m.relayDownOwnOnly },
  theirs: { auto: (m) => m.relayDownTheirs, only: (m) => m.relayDownTheirsOnly },
};

/** Notification titles while the tab is hidden; the body is the file name. */
export const NOTIFY_TITLE: Record<Dir, Record<Outcome, Text>> = {
  out: {
    done: (m) => m.notifySent,
    declined: (m) => m.notifySendDeclined,
    cancelled: (m) => m.notifySendCancelled,
    failed: (m) => m.notifySendFailed,
  },
  in: {
    done: (m) => m.notifyReceived,
    declined: (m) => m.notifyReceiveDeclined,
    cancelled: (m) => m.notifyReceiveCancelled,
    failed: (m) => m.notifyReceiveFailed,
  },
};
