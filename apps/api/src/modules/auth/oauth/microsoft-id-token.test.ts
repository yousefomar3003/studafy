// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { validateMicrosoftIdToken } from "./microsoft-id-token";

// ---------------------------------------------------------------------------
// Mock JWKS server — serves a locally-generated key pair so tests never hit Microsoft
// ---------------------------------------------------------------------------

let mockServer: ReturnType<typeof Bun.serve> | undefined;
let mockJwksUri: string;
let privateKey: CryptoKey;
let publicKeyJwk: Record<string, unknown>;

const MOCK_CLIENT_ID = "00000000-0000-0000-0000-000000000000";
const MOCK_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const MOCK_ISSUER = `https://login.microsoftonline.com/${MOCK_TENANT_ID}/v2.0`;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { modulusLength: 2048 });
  privateKey = kp.privateKey;
  const exported = await exportJWK(kp.publicKey);
  publicKeyJwk = { ...exported, kid: "test-kid-1", alg: "RS256", use: "sig" };

  mockServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/keys") {
        return Response.json({ keys: [publicKeyJwk] });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  mockJwksUri = `http://127.0.0.1:${mockServer.port}/keys`;
});

afterAll(() => {
  mockServer?.stop();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SignOptions {
  sub?: string;
  preferred_username?: string;
  email?: string;
  nonce?: string;
  aud?: string;
  iss?: string;
  exp?: number;
  name?: string;
  tid?: string;
}

async function signTestIdToken(overrides: SignOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: overrides.sub ?? "microsoft-user-123",
    preferred_username: overrides.preferred_username ?? "user@example.com",
    email: overrides.email,
    nonce: overrides.nonce ?? "expected-nonce",
    name: overrides.name,
    tid: overrides.tid ?? MOCK_TENANT_ID,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
    .setIssuer(overrides.iss ?? MOCK_ISSUER)
    .setAudience(overrides.aud ?? MOCK_CLIENT_ID)
    .setIssuedAt(now)
    .setExpirationTime(overrides.exp ?? `${now + 3600}s`)
    .sign(privateKey);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateMicrosoftIdToken", () => {
  test("accepts a valid token with tenant-specific issuer", async () => {
    const token = await signTestIdToken();
    const claims = await validateMicrosoftIdToken(
      token,
      MOCK_CLIENT_ID,
      "expected-nonce",
      mockJwksUri,
    );
    expect(claims.sub).toBe("microsoft-user-123");
    expect(claims.email).toBe("user@example.com");
    expect(claims.tenantId).toBe(MOCK_TENANT_ID);
  });

  test("rejects a token signed with a different key (forged signature)", async () => {
    const { privateKey: rogueKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      sub: "attacker",
      preferred_username: "attacker@evil.com",
      nonce: "expected-nonce",
    })
      .setProtectedHeader({ alg: "RS256", kid: "rogue-kid" })
      .setIssuer(MOCK_ISSUER)
      .setAudience(MOCK_CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(`${now + 3600}s`)
      .sign(rogueKey);

    await expect(
      validateMicrosoftIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow();
  });

  test("rejects a token with non-Microsoft issuer", async () => {
    const token = await signTestIdToken({ iss: "https://evil.com" });
    await expect(
      validateMicrosoftIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow("Invalid Microsoft token issuer");
  });

  test("rejects a token with issuer missing /v2.0 suffix", async () => {
    const token = await signTestIdToken({
      iss: `https://login.microsoftonline.com/${MOCK_TENANT_ID}`,
    });
    await expect(
      validateMicrosoftIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow("Invalid Microsoft token issuer");
  });

  test("rejects a token with wrong audience", async () => {
    const token = await signTestIdToken({ aud: "wrong-client-id" });
    await expect(
      validateMicrosoftIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow();
  });

  test("rejects a token with nonce mismatch", async () => {
    const token = await signTestIdToken({ nonce: "wrong-nonce" });
    await expect(
      validateMicrosoftIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow("nonce mismatch");
  });

  test("normalizes preferred_username to lowercase", async () => {
    const token = await signTestIdToken({ preferred_username: "User@Example.COM" });
    const claims = await validateMicrosoftIdToken(
      token,
      MOCK_CLIENT_ID,
      "expected-nonce",
      mockJwksUri,
    );
    expect(claims.email).toBe("user@example.com");
  });

  test("falls back to email claim when preferred_username is absent", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      sub: "microsoft-user-456",
      email: "fallback@example.com",
      nonce: "expected-nonce",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
      .setIssuer(MOCK_ISSUER)
      .setAudience(MOCK_CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(`${now + 3600}s`)
      .sign(privateKey);

    const claims = await validateMicrosoftIdToken(
      token,
      MOCK_CLIENT_ID,
      "expected-nonce",
      mockJwksUri,
    );
    expect(claims.email).toBe("fallback@example.com");
  });

  test("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await signTestIdToken({ exp: past });
    await expect(
      validateMicrosoftIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow();
  });

  test("rejects a malformed token", async () => {
    await expect(
      validateMicrosoftIdToken("not-a-jwt", MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow();
  });

  test("rejects a token with missing sub", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      preferred_username: "user@example.com",
      nonce: "expected-nonce",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
      .setIssuer(MOCK_ISSUER)
      .setAudience(MOCK_CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(`${now + 3600}s`)
      .sign(privateKey);

    await expect(
      validateMicrosoftIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow("missing required claims");
  });

  test("rejects a token with missing email and preferred_username", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      sub: "microsoft-user-789",
      nonce: "expected-nonce",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
      .setIssuer(MOCK_ISSUER)
      .setAudience(MOCK_CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(`${now + 3600}s`)
      .sign(privateKey);

    await expect(
      validateMicrosoftIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow("missing required claims");
  });

  test("extracts tenant ID from issuer", async () => {
    const customTenant = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const token = await signTestIdToken({
      iss: `https://login.microsoftonline.com/${customTenant}/v2.0`,
      tid: customTenant,
    });
    const claims = await validateMicrosoftIdToken(
      token,
      MOCK_CLIENT_ID,
      "expected-nonce",
      mockJwksUri,
    );
    expect(claims.tenantId).toBe(customTenant);
  });
});
