// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";

import { createMockIdp, createMockIdpIfEnabled, isMockIdpEnabled } from "../../src/dev/mock-idp";

const ISSUER = "http://localhost:4000";

function parseRedirectUrl(res: Response): URL {
  const location = res.headers.get("Location");
  if (!location) throw new Error("No Location header");
  return new URL(location);
}

describe("MockIdp", () => {
  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  test("GET /.well-known/openid-configuration returns OIDC metadata", async () => {
    const app = createMockIdp({ issuer: ISSUER });
    const res = await app.request("/.well-known/openid-configuration");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ISSUER);
    expect(body.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(body.token_endpoint).toBe(`${ISSUER}/token`);
    expect(body.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
    expect(body.response_types_supported).toContain("code");
    expect(body.id_token_signing_alg_values_supported).toContain("RS256");
  });

  // -----------------------------------------------------------------------
  // JWKS
  // -----------------------------------------------------------------------

  test("GET /.well-known/jwks.json returns a single RSA key", async () => {
    const app = createMockIdp({ issuer: ISSUER });
    const res = await app.request("/.well-known/jwks.json");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].kty).toBe("RSA");
    expect(body.keys[0].alg).toBe("RS256");
    expect(body.keys[0].use).toBe("sig");
    expect(body.keys[0].kid).toBeString();
    expect(body.keys[0].n).toBeString();
    expect(body.keys[0].e).toBeString();
  });

  // -----------------------------------------------------------------------
  // Authorize
  // -----------------------------------------------------------------------

  test("GET /authorize redirects with code and state", async () => {
    const app = createMockIdp({ issuer: ISSUER, defaultSubject: "alice@test.test" });
    const res = await app.request(
      "/authorize?redirect_uri=http://localhost:3000/callback&state=xyz",
    );
    expect(res.status).toBe(302);

    const url = parseRedirectUrl(res);
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toBe("/callback");
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(url.searchParams.get("code")).toBeString();
  });

  test("GET /authorize returns 400 when redirect_uri is missing", async () => {
    const app = createMockIdp({ issuer: ISSUER });
    const res = await app.request("/authorize");
    expect(res.status).toBe(400);
  });

  test("GET /authorize uses login_hint over defaultSubject", async () => {
    const app = createMockIdp({ issuer: ISSUER, defaultSubject: "default@test.test" });
    const res = await app.request(
      "/authorize?redirect_uri=http://localhost:3000/cb&login_hint=bob@test.test",
    );
    const url = parseRedirectUrl(res);
    const code = url.searchParams.get("code")!;

    // Exchange the code and check the subject
    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
    });
    const tokenBody = (await tokenRes.json()) as { access_token: string };
    const payload = decodeJwt(tokenBody.access_token);
    expect(payload.sub).toBe("bob@test.test");
  });

  // -----------------------------------------------------------------------
  // Token
  // -----------------------------------------------------------------------

  test("POST /token exchanges code for a signed JWT", async () => {
    const app = createMockIdp({ issuer: ISSUER, defaultSubject: "carol@test.test" });

    // Get a code
    const authRes = await app.request("/authorize?redirect_uri=http://localhost:3000/cb&state=s1");
    const code = parseRedirectUrl(authRes).searchParams.get("code")!;

    // Exchange it
    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
    });
    expect(tokenRes.status).toBe(200);

    const body = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(body.access_token).toBeString();
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);

    // Verify the JWT is valid against the IdP's own JWKS
    const jwksRes = await app.request("/.well-known/jwks.json");
    const { keys } = (await jwksRes.json()) as {
      keys: { kid: string; n: string; e: string; kty: string; alg: string; use: string }[];
    };
    const jwk = keys[0];

    const { payload } = await jwtVerify(body.access_token, jwk, {
      issuer: ISSUER,
      audience: ISSUER,
    });
    expect(payload.sub).toBe("carol@test.test");
  });

  test("POST /token rejects expired code", async () => {
    const app = createMockIdp({ issuer: ISSUER, defaultSubject: "dave@test.test" });

    const authRes = await app.request("/authorize?redirect_uri=http://localhost:3000/cb");
    const code = parseRedirectUrl(authRes).searchParams.get("code")!;

    // Code is valid immediately
    const firstRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
    });
    expect(firstRes.status).toBe(200);

    // Reuse is rejected (single-use)
    const secondRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
    });
    expect(secondRes.status).toBe(400);
    const err = (await secondRes.json()) as { error: string };
    expect(err.error).toBe("invalid_grant");
  });

  test("POST /token rejects wrong grant_type", async () => {
    const app = createMockIdp({ issuer: ISSUER });
    const res = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", code: "x" }).toString(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unsupported_grant_type");
  });

  test("POST /token rejects missing code", async () => {
    const app = createMockIdp({ issuer: ISSUER });
    const res = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code" }).toString(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  // -----------------------------------------------------------------------
  // JWT claims
  // -----------------------------------------------------------------------

  test("issued JWT carries custom claims from defaultClaims", async () => {
    const app = createMockIdp({
      issuer: ISSUER,
      defaultSubject: "eve@test.test",
      defaultClaims: { school_id: "school-1", roles: ["STUDENT"] },
    });

    const authRes = await app.request("/authorize?redirect_uri=http://localhost:3000/cb");
    const code = parseRedirectUrl(authRes).searchParams.get("code")!;

    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
    });
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const payload = decodeJwt(access_token);

    expect(payload.sub).toBe("eve@test.test");
    expect(payload.school_id).toBe("school-1");
    expect(payload.roles).toEqual(["STUDENT"]);
  });

  test("nonce passed to /authorize is echoed on the issued JWT", async () => {
    const app = createMockIdp({ issuer: ISSUER, defaultSubject: "grace@test.test" });

    const authRes = await app.request(
      "/authorize?redirect_uri=http://localhost:3000/cb&nonce=n-123",
    );
    const code = parseRedirectUrl(authRes).searchParams.get("code")!;

    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
    });
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    expect(decodeJwt(access_token).nonce).toBe("n-123");
  });

  test("no nonce claim is set when /authorize receives none", async () => {
    const app = createMockIdp({ issuer: ISSUER, defaultSubject: "heidi@test.test" });

    const authRes = await app.request("/authorize?redirect_uri=http://localhost:3000/cb");
    const code = parseRedirectUrl(authRes).searchParams.get("code")!;

    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
    });
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    expect(decodeJwt(access_token).nonce).toBeUndefined();
  });

  test("issued JWT header contains kid matching JWKS", async () => {
    const app = createMockIdp({ issuer: ISSUER, defaultSubject: "frank@test.test" });

    const authRes = await app.request("/authorize?redirect_uri=http://localhost:3000/cb");
    const code = parseRedirectUrl(authRes).searchParams.get("code")!;

    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
    });
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const header = decodeProtectedHeader(access_token);
    expect(header.kid).toBeString();

    const jwksRes = await app.request("/.well-known/jwks.json");
    const { keys } = (await jwksRes.json()) as { keys: { kid: string }[] };
    expect(keys.map((k) => k.kid)).toContain(header.kid as string);
  });
});

describe("Env guard", () => {
  test("isMockIdpEnabled returns true in development", () => {
    expect(isMockIdpEnabled({ NODE_ENV: "development" })).toBe(true);
  });

  test("isMockIdpEnabled returns true in test", () => {
    expect(isMockIdpEnabled({ NODE_ENV: "test" })).toBe(true);
  });

  test("isMockIdpEnabled returns false when APP_ENV is production", () => {
    expect(isMockIdpEnabled({ NODE_ENV: "development", APP_ENV: "production" })).toBe(false);
  });

  test("isMockIdpEnabled returns false when NODE_ENV is production", () => {
    expect(isMockIdpEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  test("createMockIdpIfEnabled returns null in production", () => {
    const result = createMockIdpIfEnabled(
      { issuer: ISSUER },
      { NODE_ENV: "production", APP_ENV: "production" },
    );
    expect(result).toBeNull();
  });

  test("createMockIdpIfEnabled returns app in development", () => {
    const result = createMockIdpIfEnabled(
      { issuer: ISSUER },
      { NODE_ENV: "development", APP_ENV: "development" },
    );
    expect(result).not.toBeNull();
  });
});
