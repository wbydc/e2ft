import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { KEYS, load, save } from "../store.ts";

const globals = globalThis as Record<string, unknown>;
let previousStorage: unknown;

const memoryStorage = (items: Map<string, string>) => ({
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => items.set(key, value),
});

const blockedStorage = {
  getItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
};

const useStorage = (storage: unknown) => {
  Object.defineProperty(globals, "localStorage", { value: storage, configurable: true });
};

beforeEach(() => {
  previousStorage = globals.localStorage;
});

afterEach(() => {
  Object.defineProperty(globals, "localStorage", { value: previousStorage, configurable: true });
});

describe("store", () => {
  describe("save", () => {
    describe("with a working storage", () => {
      test("writes the key's stored name", () => {
        const items = new Map<string, string>();
        useStorage(memoryStorage(items));

        save("lang", "ru");

        assert.equal(items.get(KEYS.lang), "ru");
      });
    });

    describe("with blocked storage", () => {
      test("does not throw", () => {
        useStorage(blockedStorage);

        assert.doesNotThrow(() => save("settings", "{}"));
      });
    });
  });

  describe("load", () => {
    describe("with a saved value", () => {
      test("returns it", () => {
        const items = new Map<string, string>();
        useStorage(memoryStorage(items));
        save("lang", "ru");

        const value = load("lang");

        assert.equal(value, "ru");
      });
    });

    describe("with nothing saved", () => {
      test("returns null", () => {
        const items = new Map<string, string>();
        useStorage(memoryStorage(items));
        save("lang", "ru");

        const value = load("theme");

        assert.equal(value, null);
      });
    });

    describe("with blocked storage", () => {
      test("returns null", () => {
        useStorage(blockedStorage);

        const value = load("settings");

        assert.equal(value, null);
      });
    });
  });
});
