import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// A room waits ROOM_WAIT seconds for its joiner; short here so the expiry test is quick.
export const ROOM_WAIT = 10;

// The server's keep-alive choices with a short first one, so the test of a keep-alive running out is quick.
export const SHORT_KEEP_ALIVE = 10;
export const KEEP_ALIVES = `0,${SHORT_KEEP_ALIVE},60,300,900,1800`;

// E2E_PORT lets a second checkout (a worktree) run the suite while another run holds the default port.
const PORT = Number(process.env.E2E_PORT ?? 18080);

// Every browser here is 127.0.0.1, and a finished spec's rooms wait out their keep-alive, so the per-client room
// cap is lifted for the suite.
const ROOMS_PER_CLIENT = 10_000;

// E2E_SERVER names a server binary built elsewhere (CI builds one for every job); unset, the suite builds its own.
export const SERVER = process.env.E2E_SERVER ?? fileURLToPath(new URL("../target/release/e2ft", import.meta.url));
export const SERVER_COMMAND = process.env.E2E_SERVER ? SERVER : "npm run serve -- --release";

export default defineConfig({
  testDir: "tests/e2e",
  // CI splits the suite into shards on separate runners; one worker each, as every browser here shares one address.
  fullyParallel: true,
  workers: 1,
  timeout: 120_000,
  // CI keeps each run's test times, which scripts/shard.mjs record turns into the shard balance.
  reporter: process.env.CI ? [["github"], ["list"], ["json", { outputFile: "e2e-times.json" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: SERVER_COMMAND,
    url: `http://127.0.0.1:${PORT}/`,
    env: {
      ADDR: `127.0.0.1:${PORT}`,
      STUN_URLS: "",
      ROOM_WAIT: String(ROOM_WAIT),
      ROOMS_PER_CLIENT: String(ROOMS_PER_CLIENT),
      KEEP_ALIVES,
    },
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
