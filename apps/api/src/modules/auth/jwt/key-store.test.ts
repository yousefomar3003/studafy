// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterEach, describe, expect, test } from "bun:test";

import { KeyStore } from "./key-store";

describe("KeyStore", () => {
  afterEach(() => {
    // Ensure timers don't leak between tests
  });

  test("throws before init", () => {
    const store = new KeyStore(60_000);
    expect(() => store.signingKey()).toThrow("not initialized");
  });

  test("generates a key pair on init without PEM", async () => {
    const store = new KeyStore(60_000);
    await store.init();
    const key = store.signingKey();
    expect(key.kid).toBeString();
    expect(key.publicKey).toBeDefined();
    expect(key.privateKey).toBeDefined();
    expect(key.createdAt).toBeInstanceOf(Date);
    store.destroy();
  });

  test("produces a valid JWKS with one key after init", async () => {
    const store = new KeyStore(60_000);
    await store.init();
    const jwks = await store.toJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].kty).toBe("RSA");
    expect(jwks.keys[0].alg).toBe("RS256");
    expect(jwks.keys[0].use).toBe("sig");
    expect(jwks.keys[0].kid).toBeString();
    store.destroy();
  });

  test("rotation adds a second key to JWKS and retires old to previous", async () => {
    const store = new KeyStore(60_000);
    await store.init();
    const firstKid = store.signingKey().kid;

    await store.rotate();
    const secondKid = store.signingKey().kid;
    expect(secondKid).not.toBe(firstKid);

    const jwks = await store.toJwks();
    expect(jwks.keys).toHaveLength(2);

    const kids = jwks.keys.map((k) => k.kid);
    expect(kids).toContain(firstKid);
    expect(kids).toContain(secondKid);
    store.destroy();
  });

  test("second rotation drops the oldest key", async () => {
    const store = new KeyStore(60_000);
    await store.init();
    const firstKid = store.signingKey().kid;

    await store.rotate();
    const secondKid = store.signingKey().kid;

    await store.rotate();
    const thirdKid = store.signingKey().kid;

    const jwks = await store.toJwks();
    expect(jwks.keys).toHaveLength(2);

    const kids = jwks.keys.map((k) => k.kid);
    expect(kids).not.toContain(firstKid);
    expect(kids).toContain(secondKid);
    expect(kids).toContain(thirdKid);
    store.destroy();
  });

  test("calls onRotate callback with new kid", async () => {
    const rotatedKids: string[] = [];
    const store = new KeyStore(60_000, (kid) => rotatedKids.push(kid));
    await store.init();
    expect(rotatedKids).toHaveLength(1);

    await store.rotate();
    expect(rotatedKids).toHaveLength(2);
    expect(rotatedKids[1]).toBeString();
    store.destroy();
  });

  test("destroy stops the rotation timer", async () => {
    const rotatedKids: string[] = [];
    const store = new KeyStore(60_000, (kid) => rotatedKids.push(kid));
    await store.init();
    store.destroy();

    // Wait a tick — the timer should not fire because it was cleared
    await new Promise((r) => setTimeout(r, 50));
    expect(rotatedKids).toHaveLength(1); // only the init rotation
  });
});
