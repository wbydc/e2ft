import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launch, registerHooks } from "./fixtures.ts";

registerHooks();

/** The legal pages and their links come only from an assets folder; a second server serves the sample one. */
const BRANDED = `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 18080) + 1}`;

let branded: ChildProcess;

test.beforeAll(async () => {
  // playwright.config.ts's webServer has built this binary.
  branded = spawn(fileURLToPath(new URL("../../../target/release/e2ft", import.meta.url)), {
    env: {
      ...process.env,
      ADDR: new URL(BRANDED).host,
      STUN_URLS: "",
      ASSETS_DIR: fileURLToPath(new URL("../assets", import.meta.url)),
    },
    stdio: "inherit",
  });
  await expect
    .poll(() =>
      fetch(BRANDED).then(
        (r) => r.status,
        () => 0,
      ),
    )
    .toBe(200);
});

test.afterAll(() => {
  branded.kill();
});

test("without an assets folder the page has no legal links and /terms and /privacy are 404", async () => {
  const peer = await launch();
  await peer.page.goto("/");

  await expect(peer.page.locator("[data-legal]")).toHaveCount(0);
  for (const path of ["/terms", "/privacy"]) expect((await peer.page.request.get(path)).status()).toBe(404);
});

test("the footer links to Terms and Privacy in the UI language, and each page loads in en and ru", async () => {
  const peer = await launch();
  const errors: string[] = [];
  peer.page.on("pageerror", (e) => errors.push(String(e)));
  peer.page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  let response = await peer.page.goto(`${BRANDED}/`);
  expect(response?.status()).toBe(200);
  const footerTerms = peer.page.locator("footer a[data-legal='terms']");
  const footerPrivacy = peer.page.locator("footer a[data-legal='privacy']");
  await expect(footerTerms).toHaveText("Terms");
  await expect(footerTerms).toHaveAttribute("href", "/terms");
  await expect(footerPrivacy).toHaveAttribute("href", "/privacy");
  const version = peer.page.locator("footer a", { hasText: /^v\d+\.\d+\.\d+$/ });
  await expect(version).toHaveAttribute(
    "href",
    `https://github.com/wbydc/e2ft/blob/${await version.textContent()}/CHANGELOG.md`,
  );
  await expect(version).toHaveAttribute("target", "_blank");
  await expect(peer.page.locator("#home .legal-note a[data-legal='terms']")).toHaveAttribute("href", "/terms");

  await peer.page.selectOption("#lang", "ru");
  await expect(footerTerms).toHaveText("Условия использования");
  await expect(footerTerms).toHaveAttribute("href", "/terms?lang=ru");
  await expect(footerPrivacy).toHaveAttribute("href", "/privacy?lang=ru");
  await expect(peer.page.locator("#home .legal-note")).toContainText("Используя e2ft, вы принимаете");

  errors.length = 0;
  // The links open a new tab, so the room in this one stays up.
  const [legal] = await Promise.all([peer.page.waitForEvent("popup"), footerTerms.click()]);
  await expect(legal).toHaveURL(`${BRANDED}/terms?lang=ru`);
  await expect(legal.locator("html")).toHaveAttribute("lang", "ru");
  await expect(legal.locator("main h1")).toHaveText("Условия использования");
  await expect(legal.locator("main .effective")).toHaveText("Дата вступления в силу: 2026-11-06");
  await legal.close();

  errors.length = 0;
  response = await peer.page.goto(`${BRANDED}/terms`);
  expect(response?.status()).toBe(200);
  await expect(peer.page.locator("html")).toHaveAttribute("lang", "en");
  await expect(peer.page.locator("main h1")).toHaveText("Terms of Service");
  await expect(peer.page.locator("main .effective")).toHaveText("Effective date: 2026-11-06");

  errors.length = 0;
  response = await peer.page.goto(`${BRANDED}/privacy?lang=ru`);
  expect(response?.status()).toBe(200);
  await expect(peer.page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(peer.page.locator("main h1")).toHaveText("Политика конфиденциальности");

  errors.length = 0;
  response = await peer.page.goto(`${BRANDED}/privacy`);
  expect(response?.status()).toBe(200);
  await expect(peer.page.locator("html")).toHaveAttribute("lang", "en");
  await expect(peer.page.locator("main h1")).toHaveText("Privacy Policy");

  expect(errors).toEqual([]);
});
