// The build-time settings: the defaults from src/config.ts with env overrides, each checked against its
// bounds. A bad value stops the build with a message naming the variable.
import { DEFAULTS } from "../src/config.ts";

const MIB = 1024 * 1024;

/** Inclusive [min, max]; GAIN's minimum is exclusive, and KEEP_ALIVES bounds each entry. */
const BOUNDS = {
  // An 8-byte frame head and a 16-byte GCM tag keep a chunk's frame within a 256 KiB data channel message.
  CHUNK_SIZE: [1024, 262_120],
  WINDOW: [16, 65_536],
  MAX_DIRECT: [1, 16],
  TURN_QUOTA: [1, 100],
  BUFFER_HIGH: [64 * 1024, 64 * MIB],
  BUFFER_LOW: [0, 64 * MIB],
  STEP_MS: [500, 60_000],
  GAIN: [1, 4],
  LANE_OPEN_MS: [1000, 120_000],
  ACK_EVERY: [1, 65_536],
  ACK_MS: [50, 10_000],
  ACCESS_LEN: [6, 16],
  // Below 6 chars (30 bits) the CPace password gets too weak to guess online.
  SECRET_LEN: [6, 16],
  KEEP_ALIVES: [0, 7200],
  KEEP_ALIVE: [0, 7200],
};

/** The invite carries the keep-alive as a 3-bit index. */
const MAX_KEEP_ALIVES = 8;
/** What the receiver may hold for reordering. */
const MAX_WINDOW_BYTES = 256 * MIB;

/** @param {Record<string, string | undefined>} env */
export function resolveConfig(env) {
  const config = { ...DEFAULTS };

  for (const name of Object.keys(DEFAULTS)) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    config[name] =
      name === "KEEP_ALIVES" ? raw.split(",").map((part) => parseNumber(name, part.trim())) : parseNumber(name, raw);
  }

  for (const [name, [min, max]] of Object.entries(BOUNDS)) {
    const values = name === "KEEP_ALIVES" ? config[name] : [config[name]];
    const low = name === "GAIN" ? (value) => value <= min : (value) => value < min;
    if (values.some((value) => low(value) || value > max))
      fail(name, config[name], `${describe(name)} from ${min} to ${max}`);
  }

  const keepAlives = config.KEEP_ALIVES;
  if (keepAlives.length > MAX_KEEP_ALIVES || keepAlives.some((value, i) => i > 0 && value <= keepAlives[i - 1]))
    fail("KEEP_ALIVES", keepAlives, `at most ${MAX_KEEP_ALIVES} ascending distinct seconds`);
  if (!keepAlives.includes(config.KEEP_ALIVE))
    fail("KEEP_ALIVE", config.KEEP_ALIVE, `one of KEEP_ALIVES (${keepAlives.join(",")})`);
  if (config.BUFFER_LOW >= config.BUFFER_HIGH)
    fail("BUFFER_LOW", config.BUFFER_LOW, `below BUFFER_HIGH (${config.BUFFER_HIGH})`);
  if (config.WINDOW * config.CHUNK_SIZE > MAX_WINDOW_BYTES)
    fail("WINDOW", config.WINDOW, `WINDOW * CHUNK_SIZE (${config.CHUNK_SIZE}) at most ${MAX_WINDOW_BYTES}`);
  if (config.ACK_EVERY > config.WINDOW) fail("ACK_EVERY", config.ACK_EVERY, `at most WINDOW (${config.WINDOW})`);

  return config;
}

function parseNumber(name, text) {
  const value = Number(text);
  if (text === "" || !Number.isFinite(value) || (name !== "GAIN" && !Number.isInteger(value))) {
    const [min, max] = BOUNDS[name];
    fail(name, text, `${describe(name)} from ${min} to ${max}`);
  }

  return value;
}

function describe(name) {
  return name === "GAIN" ? "a number above 1" : name === "KEEP_ALIVES" ? "comma-separated integers" : "an integer";
}

function fail(name, value, expected) {
  throw new Error(`${name}: ${value}, expected ${expected}`);
}
