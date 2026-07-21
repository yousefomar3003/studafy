// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { validateGoogleIdToken } from "./google-id-token";

// ---------------------------------------------------------------------------
// Mock JWKS server — serves a locally-generated key pair so tests never hit Google
// ---------------------------------------------------------------------------

let mockServer: ReturnType<typeof Bun.serve> | undefined;
let mockJwksUri: string;
let privateKey: CryptoKey;
let publicKeyJwk: Record<string, unknown>;

const MOCK_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const MOCK_ISSUER = "https://accounts.google.com";

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { modulusLength: 2048 });
  privateKey = kp.privateKey;
  const exported = await exportJWK(kp.publicKey);
  publicKeyJwk = { ...exported, kid: "test-kid-1", alg: "RS256", use: "sig" };

  mockServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/certs") {
        return Response.json({ keys: [publicKeyJwk] });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  mockJwksUri = `http://127.0.0.1:${mockServer.port}/certs`;
});

afterAll(() => {
  mockServer?.stop();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SignOptions {
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  nonce?: string;
  aud?: string;
  iss?: string;
  exp?: number;
  name?: string;
  picture?: string;
}

async function signTestIdToken(overrides: SignOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: overrides.sub ?? "google-user-123",
    email: overrides.email ?? "user@example.com",
    email_verified: overrides.emailVerified ?? true,
    nonce: overrides.nonce ?? "expected-nonce",
    name: overrides.name,
    picture: overrides.picture,
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

describe("validateGoogleIdToken", () => {
  test("accepts a valid token", async () => {
    const token = await signTestIdToken();
    const claims = await validateGoogleIdToken(
      token,
      MOCK_CLIENT_ID,
      "expected-nonce",
      mockJwksUri,
    );
    expect(claims.sub).toBe("google-user-123");
    expect(claims.email).toBe("user@example.com");
    expect(claims.emailVerified).toBe(true);
  });

  test("rejects a token signed with a different key (forged signature)", async () => {
    // Sign with a fresh key that the mock JWKS does not hold
    const { privateKey: rogueKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      sub: "attacker",
      email: "attacker@evil.com",
      email_verified: true,
      nonce: "expected-nonce",
    })
      .setProtectedHeader({ alg: "RS256", kid: "rogue-kid" })
      .setIssuer(MOCK_ISSUER)
      .setAudience(MOCK_CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(`${now + 3600}s`)
      .sign(rogueKey);

    await expect(
      validateGoogleIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow();
  });

  test("rejects a token with wrong issuer", async () => {
    const token = await signTestIdToken({ iss: "https://evil.com" });
    await expect(
      validateGoogleIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow();
  });

  test("rejects a token with wrong audience", async () => {
    const token = await signTestIdToken({ aud: "wrong-client.apps.googleusercontent.com" });
    await expect(
      validateGoogleIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow();
  });

  test("rejects a token with nonce mismatch", async () => {
    const token = await signTestIdToken({ nonce: "wrong-nonce" });
    await expect(
      validateGoogleIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow("nonce mismatch");
  });

  test("rejects a token with email_verified = false", async () => {
    const token = await signTestIdToken({ emailVerified: false });
    await expect(
      validateGoogleIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow("not verified");
  });

  test("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await signTestIdToken({ exp: past });
    await expect(
      validateGoogleIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow();
  });

  test("rejects a malformed token", async () => {
    await expect(
      validateGoogleIdToken("not-a-jwt", MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow();
  });

  test("rejects a token with missing sub", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      email: "user@example.com",
      email_verified: true,
      nonce: "expected-nonce",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
      .setIssuer(MOCK_ISSUER)
      .setAudience(MOCK_CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(`${now + 3600}s`)
      .sign(privateKey);

    await expect(
      validateGoogleIdToken(token, MOCK_CLIENT_ID, "expected-nonce", mockJwksUri),
    ).rejects.toThrow("missing required claims");
  });
});
