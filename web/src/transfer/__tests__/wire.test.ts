import { describe, test } from "node:test";
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

describe("wire", () => {
  describe("parseOffer", () => {
    describe("a well-formed offer", () => {
      test("passes unchanged", () => {
        const id = randomKey();

        const parsed = offer({ id });

        assert.deepEqual(parsed, { id, name: "report.pdf", size: 10, type: "application/pdf" });
      });
    });

    describe("a transfer id that is not 22 base64url chars", () => {
      test("is rejected", () => {
        const ids = ["", "../../etc", "a".repeat(21), "a".repeat(23), "a".repeat(21) + "/", "a".repeat(21) + "=", 7];

        const accepted = ids
          .map((id) => ({ id: String(id), parsed: offer({ id }) }))
          .filter(({ parsed }) => parsed !== null)
          .map(({ id, parsed }) => `${id}: ${JSON.stringify(parsed)}`);

        assert.deepEqual(accepted, []);
      });
    });

    describe("a name with a right-to-left override", () => {
      test("loses the format character", () => {
        const parsed = offer({ name: "invoice\u202efdp.exe" });

        assert.equal(parsed?.name, "invoicefdp.exe");
      });
    });

    describe("a name with control and format characters", () => {
      test("loses them", () => {
        const parsed = offer({ name: "a\u0000b​c\nd" });

        assert.equal(parsed?.name, "abcd");
      });
    });

    describe("a name with path separators", () => {
      test("replaces them and keeps other text", () => {
        const parsed = offer({ name: "../..\\C:evil.txt" });

        assert.equal(parsed?.name, ".._.._C_evil.txt");
      });
    });

    describe("a name in non-Latin text", () => {
      test("is kept unchanged", () => {
        const parsed = offer({ name: "Отчёт 2026 📄.pdf" });

        assert.equal(parsed?.name, "Отчёт 2026 📄.pdf");
      });
    });

    describe("a name longer than 255 chars", () => {
      test("is cut to 255 chars", () => {
        const parsed = offer({ name: "📄".repeat(300) });

        const length = Array.from(parsed?.name ?? "").length;

        assert.equal(length, 255);
      });
    });

    describe("a name that is only control and whitespace", () => {
      test("becomes the file placeholder", () => {
        const parsed = offer({ name: " \u202e\u0007 " });

        assert.equal(parsed?.name, "file");
      });
    });
  });
});
