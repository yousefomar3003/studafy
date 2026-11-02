// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { beforeAll, describe, expect, test } from "bun:test";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";

import { CodedHttpException } from "../../../coded-http-exception";
import {
  APPLE_REVOKE_URL,
  createAppleClientSecret,
  createAppleTokenRevoker,
} from "../apple-token-revoker";

import type { AppleSignInConfig } from "../apple-token-revoker";
import type { CryptoKey } from "jose";

let config: AppleSignInConfig;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  publicKey = pair.publicKey;
  config = {
    teamId: "TEAM123456",
    clientId: "com.studafy.app",
    keyId: "KEY1234567",
    privateKey: await exportPKCS8(pair.privateKey),
  };
});

function recordingFetch(response: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("createAppleClientSecret", () => {
  test("is an ES256 JWT with the claims Apple requires", async () => {
    const now = new Date("2026-09-27T10:00:00Z");
    const secret = await createAppleClientSecret(config, now);

    const { payload, protectedHeader } = await jwtVerify(secret, publicKey, {
      currentDate: now,
      audience: "https://appleid.apple.com",
      issuer: config.teamId,
      subject: config.clientId,
    });
    expect(protectedHeader).toEqual({ alg: "ES256", kid: config.keyId });
    expect(payload.exp! - payload.iat!).toBe(300);
  });
});

describe("createAppleTokenRevoker", () => {
  test("posts the token as a form to Apple's revoke endpoint", async () => {
    const { fetchFn, calls } = recordingFetch(new Response(null, { status: 200 }));

    await createAppleTokenRevoker(config, fetchFn).revoke("r.token", "refresh_token");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(APPLE_REVOKE_URL);
    expect(calls[0]!.init.method).toBe("POST");
    const form = calls[0]!.init.body as URLSearchParams;
    expect(form.get("client_id")).toBe(config.clientId);
    expect(form.get("token")).toBe("r.token");
    expect(form.get("token_type_hint")).toBe("refresh_token");
    expect(form.get("client_secret")?.split(".")).toHaveLength(3);
  });

  test("a rejection from Apple is a 502 APPLE_TOKEN_REVOCATION_FAILED", async () => {
    const { fetchFn } = recordingFetch(
      new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 }),
    );

    const error = await createAppleTokenRevoker(config, fetchFn)
      .revoke("r.token", "refresh_token")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CodedHttpException);
    expect((error as CodedHttpException).status).toBe(502);
    expect((error as CodedHttpException).code).toBe("APPLE_TOKEN_REVOCATION_FAILED");
    expect((error as CodedHttpException).message).toContain("invalid_client");
  });

  test("a network failure is a 502 as well", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const error = await createAppleTokenRevoker(config, fetchFn)
      .revoke("a.token", "access_token")
      .catch((e: unknown) => e);

    expect((error as CodedHttpException).status).toBe(502);
  });
});
