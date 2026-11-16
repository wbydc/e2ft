// The numbers that set how fast a transfer runs: buffering, acks and how many connections it spreads over. They work
// together, so they sit here side by side. Wire format constants both sides must agree on stay in wire.ts. Each is a
// build-time setting (config.ts).
import { CONFIG } from "../config.ts";

/** Data connections per direction when connection 0 went direct, connection 0 included. */
export const MAX_DIRECT = CONFIG.MAX_DIRECT;
/** The TURN server's per-user allocation quota (coturn's `user-quota`): allocations per TURN username, which
 *  both browsers of a pairing usually share, since the server makes it from the expiry second (`src/signal/ice.rs`). */
export const TURN_QUOTA = CONFIG.TURN_QUOTA;

/** A channel over this many queued bytes stops the sender until it drains below BUFFER_LOW. */
export const BUFFER_HIGH = CONFIG.BUFFER_HIGH;
/** A channel under this many queued bytes wakes the sender. */
export const BUFFER_LOW = CONFIG.BUFFER_LOW;

/** Growth: each step measures the send rate this long, and a new connection must lift it by GAIN. */
export const STEP_MS = CONFIG.STEP_MS;
export const GAIN = CONFIG.GAIN;
/** An extra connection that is not open by then counts as failed. */
export const LANE_OPEN_MS = CONFIG.LANE_OPEN_MS;

/** The sender's progress counts acked chunks, so slow links ack by time as well. */
export const ACK_EVERY = CONFIG.ACK_EVERY;
export const ACK_MS = CONFIG.ACK_MS;
