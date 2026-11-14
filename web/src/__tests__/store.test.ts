import { test } from "node:test";
import assert from "node:assert/strict";
import { KEYS, load, save } from "../store.ts";

const withStorage = (storage: unknown, run: () => void) => {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.localStorage;
  Object.defineProperty(globals, "localStorage", { value: storage, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(globals, "localStorage", { value: previous, configurable: true });
  }
};

test("load and save use the key's stored name", () => {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
  };

  withStorage(storage, () => {
    save("lang", "ru");
    assert.equal(items.get(KEYS.lang), "ru");
    assert.equal(load("lang"), "ru");
    assert.equal(load("theme"), null);
  });
});

test("blocked storage reads as empty and drops writes", () => {
  const blocked = {
    getItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
  };

  withStorage(blocked, () => {
    assert.equal(load("settings"), null);
    assert.doesNotThrow(() => save("settings", "{}"));
  });
});
