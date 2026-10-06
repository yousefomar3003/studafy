// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { googleOAuthRoutes } from "./google-route";
import { microsoftOAuthRoutes } from "./microsoft-route";
import { createMemoryStateStore } from "./state-store";

import type { GoogleOAuthDependencies } from "./google-route";
import type { MicrosoftOAuthDependencies } from "./microsoft-route";
import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { SessionTokenConfig } from "../services/session-service";

const GOOGLE_CONFIG = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://api.test/api/auth/oauth/google/callback",
  frontendUrl: "https://web.example",
};

const MICROSOFT_CONFIG = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://api.test/api/auth/oauth/microsoft/callback",
  frontendUrl: "https://web.example",
};

// One store shared by both provider apps, as app.ts shares one across every OAuth route group.
const stateStore = createMemoryStateStore();

const googleDeps: GoogleOAuthDependencies = {
  stateStore,
  getOAuthConfig: () => GOOGLE_CONFIG,
  validateIdToken: () =>
    Promise.resolve({
      sub: "sub-1",
      email: "user@example.com",
      emailVerified: true,
      name: undefined,
      picture: undefined,
    }),
};

const microsoftDeps: MicrosoftOAuthDependencies = {
  stateStore,
  getOAuthConfig: () => MICROSOFT_CONFIG,
  validateIdToken: () =>
    Promise.resolve({
      sub: "sub-1",
      email: "user@example.com",
      name: undefined,
      tenantId: undefined,
    }),
};

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

const googleApp = googleOAuthRoutes(emptyDb, {} as SessionTokenConfig, silentLogger, googleDeps);
const microsoftApp = microsoftOAuthRoutes(
  emptyDb,
  {} as SessionTokenConfig,
  silentLogger,
  microsoftDeps,
);

// The deep path exchanges the authorization code via the global fetch. Stub it only for that test
// and restore it afterwards so the mock never leaks to sibling test files sharing this process.
const originalFetch = globalThis.fetch;
const fetchMock = mock(() => Promise.resolve(new Response("{}", { status: 200 })));

afterEach(() => {
  fetchMock.mockClear();
  globalThis.fetch = originalFetch;
});

function expectRedirectToError(response: Response, code: string): void {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`https://web.example/auth/error?code=${code}`);
}

describe("OAuth callback failure redirects", () => {
  test("a declined consent screen (provider `error` param) redirects to the cancelled state", async () => {
    for (const [app, provider] of [
      [googleApp, "google"],
      [microsoftApp, "microsoft"],
    ] as const) {
      const cancelled = await app.request(
        `/api/auth/oauth/${provider}/callback?error=access_denied`,
      );
      expectRedirectToError(cancelled, "OAUTH_CANCELLED");
    }
  });

  test("missing code/state redirects to the invalid-state error instead of raw JSON", async () => {
    for (const [app, provider] of [
      [googleApp, "google"],
      [microsoftApp, "microsoft"],
    ] as const) {
      const missing = await app.request(`/api/auth/oauth/${provider}/callback`);
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
    // code. The id-token validation is a stub above and the identity lookup answers no rows.
    const start = await googleApp.request("/api/auth/oauth/google/start");
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    expect(state).not.toBeNull();

    const callback = await googleApp.request(
      `/api/auth/oauth/google/callback?code=fake-code&state=${state}`,
    );
    expectRedirectToError(callback, "AUTHZ_FORBIDDEN");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Single use: replaying the same callback finds no state and never reaches the provider again.
    const replay = await googleApp.request(
      `/api/auth/oauth/google/callback?code=fake-code&state=${state}`,
    );
    expectRedirectToError(replay, "OAUTH_STATE_INVALID");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("OAuth callback flow dispatch", () => {
  function stubTokenEndpoint(): void {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ id_token: "anything" }), { status: 200 })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  }

  test("an invitation-activation state is finished by the login callback, not rejected", async () => {
    stubTokenEndpoint();
    // What GET /api/auth/invitations/{token}/oauth/google/start writes. The provider returns the
    // browser to the one registered redirect URI — this callback — so it must run activation.
    await stateStore.set("activation-state", {
      flow: "activation",
      provider: "google",
      codeVerifier: "v",
      nonce: "n",
      token: "not-a-real-invitation-token",
    });

    const res = await googleApp.request(
      "/api/auth/oauth/google/callback?code=fake-code&state=activation-state",
    );

    // activateAccount rejects the malformed token before touching the database, and the activation
    // arm bounces back to the invite page — proof the callback dispatched rather than treating the
    // invitee as a returning user (which would have redirected to /auth/error).
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://web.example/invite/not-a-real-invitation-token",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a mobile-login state is refused by the browser callback without calling the provider", async () => {
    await stateStore.set("mobile-state", {
      flow: "mobile-login",
      provider: "google",
      codeVerifier: "v",
      nonce: "n",
    });

    const res = await googleApp.request(
      "/api/auth/oauth/google/callback?code=fake-code&state=mobile-state",
    );
    expectRedirectToError(res, "OAUTH_STATE_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a state minted for another provider is refused", async () => {
    const start = await microsoftApp.request("/api/auth/oauth/microsoft/start");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");

    const res = await googleApp.request(
      `/api/auth/oauth/google/callback?code=fake-code&state=${state}`,
    );
    expectRedirectToError(res, "OAUTH_STATE_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("start and callback may run on different instances that share the store", async () => {
    stubTokenEndpoint();
    // Two route groups over the same store stand in for two API tasks behind the load balancer.
    const instanceA = googleOAuthRoutes(
      emptyDb,
      {} as SessionTokenConfig,
      silentLogger,
      googleDeps,
    );
    const instanceB = googleOAuthRoutes(
      emptyDb,
      {} as SessionTokenConfig,
      silentLogger,
      googleDeps,
    );

    const start = await instanceA.request("/api/auth/oauth/google/start");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");

    const callback = await instanceB.request(
      `/api/auth/oauth/google/callback?code=fake-code&state=${state}`,
    );
    // Reaching the identity lookup (no account) means instance B found instance A's state.
    expectRedirectToError(callback, "AUTHZ_FORBIDDEN");
  });
});
