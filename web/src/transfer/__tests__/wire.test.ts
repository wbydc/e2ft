import { test } from "node:test";
import assert from "node:assert/strict";
import { randomKey } from "../../crypto/keys.ts";
import { parseOffer } from "../wire.ts";

const offer = (fields: Record<string, unknown>) =>
  parseOffer({
    t: "offer",
    x: 0,
    id: randomKey(),
    name: "report.pdf",
    size: 10,
    type: "application/pdf",
    ...fields,
  } as never);

test("a well-formed offer passes unchanged", () => {
  const id = randomKey();
  assert.deepEqual(offer({ id }), { id, name: "report.pdf", size: 10, type: "application/pdf" });
});

test("the transfer id must be 22 base64url chars, as randomKey makes it", () => {
  for (const id of ["", "../../etc", "a".repeat(21), "a".repeat(23), "a".repeat(21) + "/", "a".repeat(21) + "=", 7])
    assert.equal(offer({ id }), null, String(id));
});

test("names lose control and format characters, so a right-to-left override can't disguise the extension", () => {
  assert.equal(offer({ name: "invoice\u202efdp.exe" })?.name, "invoicefdp.exe");
  assert.equal(offer({ name: "a\u0000b​c\nd" })?.name, "abcd");
});

test("names lose path separators, keep other text, and stay within 255 chars", () => {
  assert.equal(offer({ name: "../..\\C:evil.txt" })?.name, ".._.._C_evil.txt");
  assert.equal(offer({ name: "Отчёт 2026 📄.pdf" })?.name, "Отчёт 2026 📄.pdf");
  assert.equal(Array.from(offer({ name: "📄".repeat(300) })?.name ?? "").length, 255);
});

test("a name with nothing left gets a placeholder", () => {
  assert.equal(offer({ name: " \u202e\u0007 " })?.name, "file");
});
