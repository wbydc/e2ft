// Build-time settings: today's values are the defaults, and `scripts/build.mjs` swaps in env overrides,
// checked by `scripts/config.mjs`, as `BUILD_CONFIG`. Unit tests run without the build and get the defaults. The
// server's copies of ACCESS_LEN, KEEP_ALIVES and KEEP_ALIVE are in build.rs. What each one means is written where
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

declare const BUILD_CONFIG: Config | undefined;

export const CONFIG: Config = typeof BUILD_CONFIG === "undefined" ? DEFAULTS : BUILD_CONFIG;
