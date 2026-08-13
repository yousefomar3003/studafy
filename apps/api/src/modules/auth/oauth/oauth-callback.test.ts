// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

// The OAuth callbacks read their config and id-token validation from these modules; mocking them
// keeps the redirect-on-failure behavior testable with no network, no env vars, and no database.
mock.module("./config", () => ({
  GOOGLE_AUTH_ENDPOINT: "https://accounts.google.com/o/oauth2/v2/auth",
  GOOGLE_TOKEN_ENDPOINT: "https://oauth2.googleapis.com/token",
  GOOGLE_JWKS_URI: "https://www.googleapis.com/oauth2/v3/certs",
  GOOGLE_ID_TOKEN_ISSUER: "https://accounts.google.com",
  GOOGLE_SCOPES: "openid email profile",
  getGoogleOAuthConfig: () => ({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://api.test/api/auth/oauth/google/callback",
    frontendUrl: "https://web.example",
  }),
}));

mock.module("./microsoft-config", () => ({
  MICROSOFT_AUTH_ENDPOINT: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  MICROSOFT_TOKEN_ENDPOINT: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  MICROSOFT_JWKS_URI: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
  MICROSOFT_ISSUER_PREFIX: "https://login.microsoftonline.com/",
  MICROSOFT_SCOPES: "openid email profile",
  getMicrosoftOAuthConfig: () => ({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://api.test/api/auth/oauth/microsoft/callback",
    frontendUrl: "https://web.example",
  }),
}));

mock.module("./google-id-token", () => ({
  validateGoogleIdToken: () =>
    Promise.resolve({ sub: "sub-1", email: "user@example.com", emailVerified: true }),
}));

mock.module("./microsoft-id-token", () => ({
  validateMicrosoftIdToken: () => Promise.resolve({ sub: "sub-1", email: "user@example.com" }),
}));

import { googleOAuthRoutes } from "./google-route";
import { microsoftOAuthRoutes } from "./microsoft-route";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { SessionTokenConfig } from "../services/session-service";

/** Stub database whose transaction body resolves no oauth identity — "no account found". */
const emptyDb = {
  begin: async (fn: (tx: unknown) => Promise<unknown>) => {
    // The identity lookup runs a `SET LOCAL ROLE` then a tagged-template SELECT; a callable tx with
    // an `unsafe` method satisfies both and always answers zero rows.
    const tx = Object.assign(async () => Promise.resolve([]), { unsafe: async () => undefined });
    await fn(tx);
    return undefined;
  },
} as unknown as Database;

const silentLogger = { warn: () => undefined } as unknown as Logger;

const googleApp = googleOAuthRoutes(emptyDb, {} as SessionTokenConfig, silentLogger);
const microsoftApp = microsoftOAuthRoutes(emptyDb, {} as SessionTokenConfig, silentLogger);

const fetchMock = mock(() => Promise.resolve(new Response("{}", { status: 200 })));

afterEach(() => {
  fetchMock.mockClear();
});

function expectRedirectToError(response: Response, code: string): void {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`https://web.example/auth/error?code=${code}`);
}

describe("OAuth callback failure redirects", () => {
  test("a declined consent screen (provider `error` param) redirects to the cancelled state", async () => {
    for (const app of [googleApp, microsoftApp]) {
      const cancelled = await app.request(
        `/api/auth/oauth/${app === googleApp ? "google" : "microsoft"}/callback?error=access_denied`,
      );
      expectRedirectToError(cancelled, "OAUTH_CANCELLED");
    }
  });

  test("missing code/state redirects to the invalid-state error instead of raw JSON", async () => {
    for (const app of [googleApp, microsoftApp]) {
      const missing = await app.request(
        `/api/auth/oauth/${app === googleApp ? "google" : "microsoft"}/callback`,
      );
      expectRedirectToError(missing, "OAUTH_STATE_INVALID");
    }
  });

  test("a stale or forged state redirects to the invalid-state error without calling the provider", async () => {
    const res = await googleApp.request(
      "/api/auth/oauth/google/callback?code=fake-code&state=never-issued",
    );
    expectRedirectToError(res, "OAUTH_STATE_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an unknown account redirects to the no-account error", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ id_token: "anything" }), { status: 200 })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Start a real flow so the state store holds a valid entry, then replay the callback with a
    // code. The id-token validation is mocked above and the identity lookup answers no rows.
    const start = await googleApp.request("/api/auth/oauth/google/start");
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    expect(state).not.toBeNull();

    const callback = await googleApp.request(
      `/api/auth/oauth/google/callback?code=fake-code&state=${state}`,
    );
    expectRedirectToError(callback, "AUTHZ_FORBIDDEN");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
