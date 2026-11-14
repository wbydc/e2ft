import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import jsQR from "jsqr";
import { encode } from "uqr";
import { BASE, Peer, createRoom, launch, registerHooks, status, tempDirectory } from "./fixtures.ts";

registerHooks();

/** RGBA of the creator's invite QR as the page draws it, rasterized in the page at `pixels` x `pixels`. */
async function qrPixels(peer: Peer, pixels: number): Promise<Uint8ClampedArray> {
  const rgba = await peer.page.evaluate(async (size) => {
    const svg = new XMLSerializer().serializeToString(document.querySelector("#invite-qr svg")!);
    const image = new Image(size, size);
    image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    await image.decode();
    const context = Object.assign(document.createElement("canvas"), { width: size, height: size }).getContext("2d")!;
    context.drawImage(image, 0, 0, size, size);

    return Array.from(context.getImageData(0, 0, size, size).data);
  }, pixels);

  return Uint8ClampedArray.from(rgba);
}

/** A one-frame .y4m (Chromium loops it as the fake camera): the square RGBA image centered on white. */
async function makeY4m(name: string, rgba: Uint8ClampedArray, pixels: number): Promise<string> {
  const [width, height] = [640, 480];
  const luma = Buffer.alloc(width * height, 235);
  const [offsetX, offsetY] = [(width - pixels) >> 1, (height - pixels) >> 1];
  for (let row = 0; row < pixels; row++) {
    for (let column = 0; column < pixels; column++) {
      const i = (row * pixels + column) * 4;
      luma[(offsetY + row) * width + offsetX + column] = Math.round(
        16 + (219 * (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2])) / 255,
      );
    }
  }
  const file = join(tempDirectory, name);
  const chroma = Buffer.alloc((width * height) / 2, 128);
  await writeFile(
    file,
    Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\nFRAME\n`), luma, chroma]),
  );

  return file;
}

/** RGBA of a QR made in Node, `scale` px per module. */
function qrRgba(text: string, scale: number): { rgba: Uint8ClampedArray; px: number } {
  const { data, size } = encode(text, { border: 4 });
  const pixels = size * scale;
  const rgba = new Uint8ClampedArray(pixels * pixels * 4).fill(255);
  for (let i = 0; i < pixels * pixels; i++)
    if (data[Math.floor(i / pixels / scale)][Math.floor((i % pixels) / scale)]) rgba.fill(0, i * 4, i * 4 + 3);

  return { rgba, px: pixels };
}

test("the invite QR decodes to the invite link, toggles next to Copy Link, and a phone that scans it joins", async () => {
  const creator = await launch();
  const invite = await createRoom(creator);
  await expect(creator.page.locator("#invite-qr svg")).toBeVisible();
  const pixels = 400;
  const rgba = await qrPixels(creator, pixels);
  expect(jsQR(rgba, pixels, pixels)?.data).toBe(invite);
  await creator.page.click("#show-qr");
  await expect(creator.page.locator("#invite-qr")).toBeHidden();
  await expect(creator.page.locator("#show-qr")).toHaveAttribute("aria-label", "Show QR Code");

  await creator.page.setViewportSize({ width: 390, height: 844 });
  await expect(creator.page.locator("#invite-qr")).toBeHidden();
  await creator.page.click("#show-qr");
  await expect(creator.page.locator("#invite-qr svg")).toBeVisible();
  await expect(creator.page.locator("#show-qr")).toHaveAttribute("aria-label", "Hide QR Code");

  const joiner = await launch("chromium", { camera: { file: await makeY4m("invite.y4m", rgba, pixels), allow: true } });
  await joiner.page.goto("/");
  const lazy = joiner.page.waitForRequest(/\/jsqr\.js\?v=[0-9a-f]{12}$/);
  await joiner.page.click("#scan");
  await lazy;
  // The scan opens the Join screen; only its Join connects.
  await expect(joiner.page.locator("#settings")).toBeVisible();
  await expect(joiner.page.locator("#settings-title")).toHaveText("Join room");
  await joiner.page.locator("#set-submit").click();
  await expect(status(creator)).toContainText("Connected");
  await expect(status(joiner)).toContainText("Connected");
  await expect(joiner.page.locator("#scanner")).not.toBeVisible();
  expect(
    await joiner.page.evaluate(() => (document.getElementById("scan-video") as HTMLVideoElement).srcObject),
  ).toBeNull();
  await expect(creator.page.locator("#qr-box")).toBeHidden();
  await expect(creator.page.locator("#show-qr")).toBeHidden();
});

test("with the hide-QR setting a new room starts with the QR hidden and the toggle shows it", async () => {
  const creator = await launch();
  await creator.page.goto("/");
  await creator.page.click("#settings-btn");
  await creator.page.selectOption("#set-qr", "hide");
  await creator.page.click("#set-submit");
  await creator.page.click("#create");
  await expect(status(creator)).toContainText("Room ready");
  await expect(creator.page.locator("#invite-qr")).toBeHidden();
  await expect(creator.page.locator("#show-qr")).toHaveAttribute("aria-label", "Show QR Code");
  await creator.page.click("#show-qr");
  await expect(creator.page.locator("#invite-qr svg")).toBeVisible();
});

test("a QR that is not this site's invite shows an error and joins nothing; Cancel stops the camera", async () => {
  const { rgba, px: pixels } = qrRgba(`https://evil.example/r/${"A".repeat(8)}#${"0".repeat(8)}`, 8);
  const joiner = await launch("chromium", { camera: { file: await makeY4m("evil.y4m", rgba, pixels), allow: true } });
  await joiner.page.goto("/");
  expect(
    await joiner.page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("jsqr"))),
  ).toBe(false);
  await joiner.page.click("#scan");
  await expect(joiner.page.locator("#scan-error")).toHaveText("This QR code is not a e2ft invite for this site.");
  await expect(joiner.page.locator("#home")).toBeVisible();
  expect(joiner.page.url()).toBe(`${BASE}/`);
  await joiner.page.getByRole("button", { name: "Cancel" }).click();
  await expect(joiner.page.locator("#scanner")).not.toBeVisible();
  await expect
    .poll(() => joiner.page.evaluate(() => (document.getElementById("scan-video") as HTMLVideoElement).srcObject))
    .toBeNull();
});

test("a refused camera shows a message in the scanner", async () => {
  const { rgba, px: pixels } = qrRgba("x", 8);
  const joiner = await launch("chromium", {
    camera: { file: await makeY4m("denied.y4m", rgba, pixels), allow: false },
  });
  await joiner.page.goto("/");
  await joiner.page.click("#scan");
  await expect(joiner.page.locator("#scan-error")).toContainText("Camera access is blocked");
});
