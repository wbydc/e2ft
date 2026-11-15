// The tuning settings: the server reads them from its environment at startup, checks them, and writes them into
// the page as the `#config` JSON block, which this module reads once at import. The defaults below match the
// server's (src/settings.rs) and serve unit tests, which run without a page. What each one means is written where
// it is used: transfer/wire.ts, transfer/constants.ts, crypto/invite.ts, net/settings.ts.

export const DEFAULTS = {
  CHUNK_SIZE: 64 * 1024,
  WINDOW: 1024,
  MAX_DIRECT: 8,
  TURN_QUOTA: 12,
  BUFFER_HIGH: 8 * 1024 * 1024,
  BUFFER_LOW: 1024 * 1024,
  STEP_MS: 3000,
  GAIN: 1.2,
  LANE_OPEN_MS: 10_000,
  ACK_EVERY: 32,
  ACK_MS: 500,
  ACCESS_LEN: 8,
  SECRET_LEN: 6,
  KEEP_ALIVES: [0, 60, 300, 900, 1800] as readonly number[],
  KEEP_ALIVE: 300,
};

export type Config = typeof DEFAULTS;

const block = typeof document === "undefined" ? null : document.getElementById("config");

export const CONFIG: Config = block?.textContent ? (JSON.parse(block.textContent) as Config) : DEFAULTS;

