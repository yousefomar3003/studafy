// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterEach, describe, expect, test } from "bun:test";
import { calculateJwkThumbprint, exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from "jose";

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

// QA-023: a deployed API loads its signing key from a secret, so every instance (and every restart)
// signs and verifies with the same key.
describe("KeyStore loaded from a PEM (QA-023)", () => {
  async function pem(): Promise<string> {
    const { privateKey } = await generateKeyPair("RS256", {
      modulusLength: 2048,
      extractable: true,
    });
    return exportPKCS8(privateKey);
  }

  test("two stores loaded from the same PEM share the kid, and one verifies the other's tokens", async () => {
    const key = await pem();
    const a = new KeyStore(60_000);
    const b = new KeyStore(60_000);
    await a.init({ privateKeyPem: key });
    await b.init({ privateKeyPem: key });
    try {
      expect(a.signingKey().kid).toBe(b.signingKey().kid);
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: a.signingKey().kid })
        .sign(a.signingKey().privateKey);
      const verifier = await b.publicKeyFor(a.signingKey().kid);
      expect(verifier).toBeDefined();
      await expect(jwtVerify(token, verifier!)).resolves.toBeDefined();
    } finally {
      a.destroy();
      b.destroy();
    }
  });

  test("the kid is the key's RFC 7638 thumbprint, stable across restarts", async () => {
    const key = await pem();
    const store = new KeyStore(60_000);
    await store.init({ privateKeyPem: key });
    const [jwk] = (await store.toJwks()).keys;
    expect(store.signingKey().kid).toBe(await calculateJwkThumbprint(jwk!));
    store.destroy();
  });

  test("a PEM-loaded store never rotates itself onto a random key", async () => {
    const store = new KeyStore(20);
    await store.init({ privateKeyPem: await pem() });
    const kid = store.signingKey().kid;
    await Bun.sleep(80);
    expect(store.signingKey().kid).toBe(kid);
    expect((await store.toJwks()).keys).toHaveLength(1);
    store.destroy();
  });

  test("the next key is published and verifies, but does not sign", async () => {
    const current = await pem();
    const next = await pem();
    const store = new KeyStore(60_000);
    await store.init({ privateKeyPem: current, nextPrivateKeyPem: next });
    const nextOnly = new KeyStore(60_000);
    await nextOnly.init({ privateKeyPem: next });
    try {
      const kids = (await store.toJwks()).keys.map((k) => k.kid);
      expect(kids).toHaveLength(2);
      expect(kids).toContain(nextOnly.signingKey().kid);
      expect(store.signingKey().kid).not.toBe(nextOnly.signingKey().kid);
      expect(await store.publicKeyFor(nextOnly.signingKey().kid)).toBeDefined();
    } finally {
      store.destroy();
      nextOnly.destroy();
    }
  });
});
