import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import {
  calculateGenerator,
  deriveIsk,
  generatorString,
  lvCat,
  prependLen,
  scalarFromLe,
  scalarMultVfy,
} from "../cpace.ts";

const ristretto = { ristretto255, ristretto255_hasher };
const hex = (text: string) => Uint8Array.from(text.replace(/\s/g, "").match(/../g)!, (byte) => parseInt(byte, 16));
const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const encoder = new TextEncoder();

// draft-irtf-cfrg-cpace-21, Appendix A.1 and B.3 (ristretto255, SHA-512).
const prs = encoder.encode("Password");
const ci = hex("0b415f696e69746961746f720b425f726573706f6e646572");
const SID = hex("7e4b4791d6a8ef019b936c79fb7f2c57");
const scalarA = scalarFromLe(hex("da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08"));
const scalarB = scalarFromLe(hex("d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d"));
const Ya = "d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157";
const Yb = "3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258";
const K = "80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f";

describe("cpace", () => {
  describe("prependLen", () => {
    test("prefixes an empty input with its zero length", () => {
      const prefixed = prependLen(new Uint8Array(0));

      assert.equal(toHex(prefixed), "00");
    });

    test("prefixes a short input with its length", () => {
      const prefixed = prependLen(encoder.encode("1234"));

      assert.equal(toHex(prefixed), "0431323334");
    });

    test("encodes a 128-byte length in two bytes", () => {
      const prefixed = prependLen(Uint8Array.from({ length: 128 }, (_, i) => i));

      assert.equal(toHex(prefixed).slice(0, 6), "800100");
    });
  });

  describe("lvCat", () => {
    test("concatenates its parts with their lengths", () => {
      const cat = lvCat(encoder.encode("1234"), encoder.encode("5"), new Uint8Array(0), encoder.encode("678"));

      assert.equal(toHex(cat), "043132333401350003363738");
    });
  });

  describe("generatorString", () => {
    test("builds the draft's 170-byte string", () => {
      const generatorBytes = generatorString(prs, ci, SID);

      assert.equal(generatorBytes.byteLength, 170);
      assert.equal(
        toHex(generatorBytes),
        "11435061636552697374726574746f3235350850617373776f726464" +
          "00".repeat(100) +
          "180b415f696e69746961746f720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f2c57",
      );
    });
  });

  describe("calculateGenerator", () => {
    test("derives the draft's generator", async () => {
      const generator = await calculateGenerator(ristretto, prs, ci, SID);

      assert.equal(toHex(generator.toBytes()), "222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56");
    });

    test("multiplied by the initiator's scalar gives Ya", async () => {
      const generator = await calculateGenerator(ristretto, prs, ci, SID);

      const share = generator.multiply(scalarA).toBytes();

      assert.equal(toHex(share), Ya);
    });

    test("multiplied by the responder's scalar gives Yb", async () => {
      const generator = await calculateGenerator(ristretto, prs, ci, SID);

      const share = generator.multiply(scalarB).toBytes();

      assert.equal(toHex(share), Yb);
    });
  });

  describe("scalarMultVfy", () => {
    test("the responder's share times the initiator's scalar gives K", () => {
      const key = scalarMultVfy(ristretto, scalarA, hex(Yb))!;

      assert.equal(toHex(key), K);
    });

    test("the initiator's share times the responder's scalar gives K", () => {
      const key = scalarMultVfy(ristretto, scalarB, hex(Ya))!;

      assert.equal(toHex(key), K);
    });

    test("multiplies a valid point by a scalar", () => {
      const scalar = scalarFromLe(hex("7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05"));
      const point = hex("2c3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c");

      const product = scalarMultVfy(ristretto, scalar, point)!;

      assert.equal(toHex(product), "7c13645fe790a468f62c39beb7388e541d8405d1ade69d1778c5fe3e7f6b600e");
    });

    test("refuses an invalid point", () => {
      const scalar = scalarFromLe(hex("7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05"));
      const point = hex("2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c");

      const product = scalarMultVfy(ristretto, scalar, point);

      assert.equal(product, null);
    });

    test("refuses the identity", () => {
      const scalar = scalarFromLe(hex("7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05"));
      const identity = new Uint8Array(32);

      const product = scalarMultVfy(ristretto, scalar, identity);

      assert.equal(product, null, "identity");
    });
  });

  describe("deriveIsk", () => {
    test("derives the draft's ISK", async () => {
      const isk = await deriveIsk(SID, hex(K), hex(Ya), encoder.encode("ADa"), hex(Yb), encoder.encode("ADb"));

      assert.equal(
        toHex(isk),
        "b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447",
      );
    });
  });
});
