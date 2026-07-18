// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";
import { jwtVerify } from "jose";

import { KeyStore } from "./key-store";
import { signAccessToken } from "./sign";
import { verifyAccessToken, TokenVerificationError } from "./verify";

import type { JwtPayload } from "./types";
import type { Role } from "@studafy/constants";

const ISSUER = "studafy-test";
const AUDIENCE = "studafy-api-test";
const TTL = 900;

const signParams = {
  sub: "11111111-1111-1111-1111-111111111111",
  school_id: "22222222-2222-2222-2222-222222222222",
  roles: ["INSTRUCTOR", "STUDENT"] as Role[],
  entitlements_ver: 3,
};

let store: KeyStore;

// Shared store for the whole describe block
async function getStore(): Promise<KeyStore> {
  if (!store) {
    store = new KeyStore(60_000);
    await store.init();
  }
  return store;
}

describe("signAccessToken", () => {
  test("returns a three-part JWT string", async () => {
    const ks = await getStore();
    const token = await signAccessToken(ks, signParams, {
      issuer: ISSUER,
      audience: AUDIENCE,
      ttlSeconds: TTL,
    });
    expect(token.split(".")).toHaveLength(3);
  });

  test("jti is a UUID v4", async () => {
    const ks = await getStore();
    const token = await signAccessToken(ks, signParams, {
      issuer: ISSUER,
      audience: AUDIENCE,
      ttlSeconds: TTL,
    });
    const payload = decodePayload(token);
    expect(payload.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test("jti is unique across calls", async () => {
    const ks = await getStore();
    const t1 = await signAccessToken(ks, signParams, {
      issuer: ISSUER,
      audience: AUDIENCE,
      ttlSeconds: TTL,
    });
    const t2 = await signAccessToken(ks, signParams, {
      issuer: ISSUER,
      audience: AUDIENCE,
      ttlSeconds: TTL,
    });
    expect(decodePayload(t1).jti).not.toBe(decodePayload(t2).jti);
  });

  test("all required claims are present", async () => {
    const ks = await getStore();
    const token = await signAccessToken(ks, signParams, {
      issuer: ISSUER,
      audience: AUDIENCE,
      ttlSeconds: TTL,
    });
    const payload = decodePayload(token);

    expect(payload.sub).toBe(signParams.sub);
    expect(payload.school_id).toBe(signParams.school_id);
    expect(payload.roles).toEqual(signParams.roles);
    expect(payload.entitlements_ver).toBe(signParams.entitlements_ver);
    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe(AUDIENCE);
    expect(payload.iat).toBeNumber();
    expect(payload.exp).toBeNumber();
    expect(payload.nbf).toBeNumber();
    expect(payload.exp - payload.iat).toBe(TTL);
  });

  test("header contains kid matching the signing key", async () => {
    const ks = await getStore();
    const token = await signAccessToken(ks, signParams, {
      issuer: ISSUER,
      audience: AUDIENCE,
      ttlSeconds: TTL,
    });
    const headerB64 = token.split(".")[0];
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    expect(header.kid).toBe(ks.signingKey().kid);
    expect(header.alg).toBe("RS256");
  });
});

describe("verifyAccessToken", () => {
  test("verifies a valid token", async () => {
    const ks = await getStore();
    const token = await signAccessToken(ks, signParams, {
      issuer: ISSUER,
      audience: AUDIENCE,
      ttlSeconds: TTL,
    });
    const payload = await verifyAccessToken(ks, token, { issuer: ISSUER, audience: AUDIENCE });
    expect(payload.sub).toBe(signParams.sub);
    expect(payload.school_id).toBe(signParams.school_id);
  });

  test("rejects token signed with a rotated-out key (only if old key is gone)", async () => {
    const ks = new KeyStore(60_000);
    await ks.init();
    const token = await signAccessToken(ks, signParams, {
      issuer: ISSUER,
      audience: AUDIENCE,
      ttlSeconds: TTL,
    });

    // Rotate twice — the original key is now fully gone
    await ks.rotate();
    await ks.rotate();

    await expect(
      verifyAccessToken(ks, token, { issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow(TokenVerificationError);
    ks.destroy();
  });

  test("rejects token with wrong issuer", async () => {
    const ks = await getStore();
    const token = await signAccessToken(ks, signParams, {
      issuer: ISSUER,
      audience: AUDIENCE,
      ttlSeconds: TTL,
    });
    await expect(
      verifyAccessToken(ks, token, { issuer: "wrong-issuer", audience: AUDIENCE }),
    ).rejects.toThrow(TokenVerificationError);
  });

  test("rejects token with wrong audience", async () => {
    const ks = await getStore();
    const token = await signAccessToken(ks, signParams, {
      issuer: ISSUER,
      audience: AUDIENCE,
      ttlSeconds: TTL,
    });
    await expect(
      verifyAccessToken(ks, token, { issuer: ISSUER, audience: "wrong-audience" }),
    ).rejects.toThrow(TokenVerificationError);
  });

  test("rejects a malformed token", async () => {
    const ks = await getStore();
    await expect(
      verifyAccessToken(ks, "not.a.jwt", { issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow(TokenVerificationError);
  });

  test("rejects a tampered token", async () => {
    const ks = await getStore();
    const token = await signAccessToken(ks, signParams, {
      issuer: ISSUER,
      audience: AUDIENCE,
      ttlSeconds: TTL,
    });
    const parts = token.split(".");
    // Tamper with the last byte of the payload
    const payload = Buffer.from(parts[1], "base64url");
    payload[payload.length - 1] ^= 0xff;
    const tampered = `${parts[0]}.${Buffer.from(payload).toString("base64url")}.${parts[2]}`;
    await expect(
      verifyAccessToken(ks, tampered, { issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow(TokenVerificationError);
  });
});

describe("claims schema", () => {
  test("roles is an array of valid role strings", async () => {
    const ks = await getStore();
    const token = await signAccessToken(
      ks,
      { ...signParams, roles: ["SUPER_ADMIN", "INSTRUCTOR"] },
      { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: TTL },
    );
    const payload = await verifyAccessToken(ks, token, { issuer: ISSUER, audience: AUDIENCE });
    expect(payload.roles).toEqual(["SUPER_ADMIN", "INSTRUCTOR"]);
  });

  test("entitlements_ver is carried through correctly", async () => {
    const ks = await getStore();
    const token = await signAccessToken(
      ks,
      { ...signParams, entitlements_ver: 42 },
      { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: TTL },
    );
    const payload = await verifyAccessToken(ks, token, { issuer: ISSUER, audience: AUDIENCE });
    expect(payload.entitlements_ver).toBe(42);
  });

  test("school_id is carried through correctly", async () => {
    const ks = await getStore();
    const schoolId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const token = await signAccessToken(
      ks,
      { ...signParams, school_id: schoolId },
      { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: TTL },
    );
    const payload = await verifyAccessToken(ks, token, { issuer: ISSUER, audience: AUDIENCE });
    expect(payload.school_id).toBe(schoolId);
  });

  test("token is verifiable directly with jose using JWKS from key-store", async () => {
    const ks = await getStore();
    const token = await signAccessToken(ks, signParams, {
      issuer: ISSUER,
      audience: AUDIENCE,
      ttlSeconds: TTL,
    });
    const { keys } = await ks.toJwks();
    const { createLocalJWKSet } = await import("jose");
    const jwks = createLocalJWKSet({ keys });
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: AUDIENCE });
    expect(payload.sub).toBe(signParams.sub);
  });
});

/**
 * Decode the JWT payload without verification — for assertion-only use in tests.
 */
function decodePayload(token: string): JwtPayload {
  const payloadB64 = token.split(".")[1];
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as JwtPayload;
}
