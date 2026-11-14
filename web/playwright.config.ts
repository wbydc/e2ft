import { defineConfig } from "@playwright/test";

// A room waits ROOM_WAIT seconds for its joiner; short here so the expiry test is quick.
export const ROOM_WAIT = 10;

// The build's keep-alive choices with a short first one, so the test of a keep-alive running out is quick. The
// integration config builds with the same list, so switching between the two suites does not rebuild.
export const SHORT_KEEP_ALIVE = 10;
export const KEEP_ALIVES = `0,${SHORT_KEEP_ALIVE},60,300,900,1800`;

// E2E_PORT lets a second checkout (a worktree) run the suite while another run holds the default port.
const PORT = Number(process.env.E2E_PORT ?? 18080);

// Every browser here is 127.0.0.1, and a finished spec's rooms wait out their keep-alive, so the per-client room
// cap is lifted for the suite.
const ROOMS_PER_CLIENT = 10_000;

export default defineConfig({
  testDir: "tests/e2e",
  // CI splits the suite into shards on separate runners; one worker each, as every browser here shares one address.
  fullyParallel: true,
  workers: 1,
  timeout: 120_000,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: "cargo run --release",
    cwd: "..",
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
