// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { createStateStore } from "./state-store";

describe("createStateStore", () => {
  test("set/get round-trip", () => {
    const store = createStateStore();
    store.set("s1", { codeVerifier: "v", nonce: "n", createdAt: Date.now() });
    const entry = store.get("s1");
    expect(entry).toBeDefined();
    expect(entry?.codeVerifier).toBe("v");
    expect(entry?.nonce).toBe("n");
  });

  test("returns undefined for missing key", () => {
    const store = createStateStore();
    expect(store.get("nonexistent")).toBeUndefined();
  });

  test("returns undefined for expired entry", () => {
    const store = createStateStore(100); // 100ms TTL
    store.set("s1", { codeVerifier: "v", nonce: "n", createdAt: Date.now() - 200 });
    expect(store.get("s1")).toBeUndefined();
  });

  test("delete removes entry", () => {
    const store = createStateStore();
    store.set("s1", { codeVerifier: "v", nonce: "n", createdAt: Date.now() });
    store.delete("s1");
    expect(store.get("s1")).toBeUndefined();
  });

  test("delete on missing key is a no-op", () => {
    const store = createStateStore();
    store.delete("nonexistent"); // should not throw
  });

  test("entries become inaccessible after TTL", async () => {
    const store = createStore(50);
    store.set("s1", { codeVerifier: "v", nonce: "n", createdAt: Date.now() });
    // Immediately available
    expect(store.get("s1")).toBeDefined();
    // Wait for expiry
    await new Promise((r) => setTimeout(r, 60));
    expect(store.get("s1")).toBeUndefined();
  });
});

function createStore(ttlMs: number) {
  return createStateStore(ttlMs);
}
