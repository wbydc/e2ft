import { defineConfig } from "@playwright/test";
import { KEEP_ALIVES } from "./playwright.config.ts";

// Needs the loopback coturns from scripts/coturn.sh; the secret is the same test value that script defaults to.
export const TURN_SECRET = process.env.E2E_TURN_SECRET ?? "e2e-loopback-turn-secret-0123456789";

const PORT = Number(process.env.E2E_PORT ?? 18080);

// A second server signs with a secret coturn does not know, to prove the relay check fails without coturn's yes.
export const WRONG_SECRET_URL = `http://127.0.0.1:${PORT + 1}`;

// Playwright starts the servers one after another, so the second reuses the frontend the first one built.
const server = (port: number, secret: string, command: string) => ({
  command,
  url: `http://127.0.0.1:${port}/`,
  env: { ADDR: `127.0.0.1:${port}`, STUN_URLS: "", TURN_URLS: "turn:127.0.0.1:3481", TURN_SECRET: secret, KEEP_ALIVES },
  timeout: 300_000,
  reuseExistingServer: false,
});

export default defineConfig({
  testDir: "tests/integration",
  workers: 1,
  timeout: 120_000,
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: [
    server(PORT, TURN_SECRET, "npm run serve -- --release"),
    server(PORT + 1, `wrong-${TURN_SECRET}`, "cd .. && cargo run --release"),
  ],
});
