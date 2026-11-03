import { createHash } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

import { OAUTH_BINDING_COOKIE_NAME } from "./browser-binding";
import { takeAuthorization } from "./callback-flows";
import { googleOAuthRoutes } from "./google-route";
import { microsoftOAuthRoutes } from "./microsoft-route";
import { redeemHandoff } from "./mobile-handoff";
import { createMemoryStateStore } from "./state-store";

import type { CallbackContext } from "./callback-flows";
import type { GoogleOAuthDependencies } from "./google-route";
import type { MicrosoftOAuthDependencies } from "./microsoft-route";
import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
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

/** The `Cookie` header a browser would send back after this start response set the binding. */
function bindingCookieFrom(start: Response): string {
  const match = /studafy_oauth_binding=([^;]+)/.exec(start.headers.get("set-cookie") ?? "");
  expect(match).not.toBeNull();
  return `${OAUTH_BINDING_COOKIE_NAME}=${match![1]!}`;
}

/** A browser's binding secret and the hash a start would have stored for it. */
const BROWSER_SECRET = "b".repeat(43);
const BROWSER_COOKIE = `${OAUTH_BINDING_COOKIE_NAME}=${BROWSER_SECRET}`;
const BROWSER_BINDING = createHash("sha256").update(BROWSER_SECRET).digest("base64url");

async function startFlow(
  app: typeof googleApp,
  provider: "google" | "microsoft",
): Promise<{ state: string; cookie: string }> {
  const start = await app.request(`/api/auth/oauth/${provider}/start`);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  return { state, cookie: bindingCookieFrom(start) };
}

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
    const { state, cookie } = await startFlow(googleApp, "google");

    const callback = await googleApp.request(
      `/api/auth/oauth/google/callback?code=fake-code&state=${state}`,
      { headers: { Cookie: cookie } },
    );
    expectRedirectToError(callback, "AUTHZ_FORBIDDEN");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Single use: replaying the same callback finds no state and never reaches the provider again.
    const replay = await googleApp.request(
      `/api/auth/oauth/google/callback?code=fake-code&state=${state}`,
      { headers: { Cookie: cookie } },
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
      browserBinding: BROWSER_BINDING,
    });

    const res = await googleApp.request(
      "/api/auth/oauth/google/callback?code=fake-code&state=activation-state",
      { headers: { Cookie: BROWSER_COOKIE } },
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

  test("a mobile-login state is handed to the app as a one-time code, redeemable once", async () => {
    stubTokenEndpoint();
    // What /mobile-start writes. The app opened /mobile-authorize, so Google returned here.
    await stateStore.set("mobile-state", {
      flow: "mobile-login",
      provider: "google",
      codeVerifier: "v",
      nonce: "mobile-nonce",
    });

    const res = await googleApp.request(
      "/api/auth/oauth/google/callback?code=fake-code&state=mobile-state",
    );

    // Back to the app's deep link with a fresh code — never Google's own code — and the state.
    expect(res.status).toBe(302);
    const deepLink = new URL(res.headers.get("location")!);
    expect(`${deepLink.protocol}//${deepLink.host}${deepLink.pathname}`).toBe(
      "studafy://auth/callback",
    );
    expect(deepLink.searchParams.get("state")).toBe("mobile-state");
    const handoffCode = deepLink.searchParams.get("code")!;
    expect(handoffCode).not.toBe("fake-code");

    // The verified identity waits under that code, bound to the state and nonce.
    const redeemed = await redeemHandoff(stateStore, {
      code: handoffCode,
      state: "mobile-state",
      nonce: "mobile-nonce",
      provider: "google",
      purpose: "login",
    });
    expect(redeemed?.identity).toEqual({ sub: "sub-1", email: "user@example.com" });
    expect(
      await redeemHandoff(stateStore, {
        code: handoffCode,
        state: "mobile-state",
        nonce: "mobile-nonce",
        provider: "google",
        purpose: "login",
      }),
    ).toBeUndefined();
  });

  test("a handoff is refused without the app's nonce (an intercepted deep link is not enough)", async () => {
    stubTokenEndpoint();
    await stateStore.set("mobile-state-2", {
      flow: "mobile-login",
      provider: "google",
      codeVerifier: "v",
      nonce: "secret-nonce",
    });
    const res = await googleApp.request(
      "/api/auth/oauth/google/callback?code=fake-code&state=mobile-state-2",
    );
    const handoffCode = new URL(res.headers.get("location")!).searchParams.get("code")!;

    expect(
      await redeemHandoff(stateStore, {
        code: handoffCode,
        state: "mobile-state-2",
        nonce: "guessed-nonce",
        provider: "google",
        purpose: "login",
      }),
    ).toBeUndefined();
  });

  test("a failed mobile sign-in returns to the app, not the web error page", async () => {
    await stateStore.set("mobile-cancel", {
      flow: "mobile-login",
      provider: "google",
      codeVerifier: "v",
      nonce: "n",
    });
    const cancelled = await googleApp.request(
      "/api/auth/oauth/google/callback?error=access_denied&state=mobile-cancel",
    );
    expect(cancelled.headers.get("location")).toBe("studafy://auth/callback?error=OAUTH_CANCELLED");

    // A provider-level failure (token endpoint down) for a mobile flow lands in the app too.
    fetchMock.mockImplementation(() => Promise.resolve(new Response("{}", { status: 500 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await stateStore.set("mobile-fail", {
      flow: "mobile-login",
      provider: "google",
      codeVerifier: "v",
      nonce: "n",
    });
    const failed = await googleApp.request(
      "/api/auth/oauth/google/callback?code=fake-code&state=mobile-fail",
    );
    expect(failed.headers.get("location")).toBe(
      "studafy://auth/callback?error=OAUTH_PROVIDER_ERROR",
    );
  });

  test("a handoff code is never accepted as an authorization state", async () => {
    await stateStore.set("handoff-code", {
      flow: "mobile-handoff",
      provider: "google",
      purpose: "login",
      state: "s",
      nonce: "n",
      identity: { sub: "sub-1", email: "user@example.com" },
    });
    const res = await googleApp.request(
      "/api/auth/oauth/google/callback?code=fake-code&state=handoff-code",
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

    const { state, cookie } = await startFlow(instanceA, "google");

    const callback = await instanceB.request(
      `/api/auth/oauth/google/callback?code=fake-code&state=${state}`,
      { headers: { Cookie: cookie } },
    );
    // Reaching the identity lookup (no account) means instance B found instance A's state.
    expectRedirectToError(callback, "AUTHZ_FORBIDDEN");
  });
});

describe("OAuth browser binding (QA-20 / F-07 login CSRF)", () => {
  for (const [app, provider] of [
    [googleApp, "google"],
    [microsoftApp, "microsoft"],
  ] as const) {
    test(`${provider}: start binds the flow with an HttpOnly, Lax cookie scoped to the callbacks`, async () => {
      const start = await app.request(`/api/auth/oauth/${provider}/start`);
      const setCookie = start.headers.get("set-cookie")!;
      expect(setCookie).toContain(`${OAUTH_BINDING_COOKIE_NAME}=`);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/api/auth/oauth");
      expect(setCookie).toContain("Max-Age=300");

      // A second start in the same browser keeps its secret, so two tabs can both finish.
      const cookie = bindingCookieFrom(start);
      const again = await app.request(`/api/auth/oauth/${provider}/start`, {
        headers: { Cookie: cookie },
      });
      expect(bindingCookieFrom(again)).toBe(cookie);
    });

    test(`${provider}: a valid state without the binding cookie is rejected and sets no cookie`, async () => {
      stubTokenEndpointForBinding();
      const { state } = await startFlow(app, provider);

      const res = await app.request(
        `/api/auth/oauth/${provider}/callback?code=attacker-code&state=${state}`,
      );
      expectRedirectToError(res, "OAUTH_STATE_INVALID");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test(`${provider}: a valid state with another browser's binding cookie is rejected and sets no cookie`, async () => {
      stubTokenEndpointForBinding();
      // The attacker starts the flow in their browser and sends the callback URL to the victim,
      // whose browser has its own binding cookie from a flow of its own.
      const attacker = await startFlow(app, provider);
      const victim = await startFlow(app, provider);
      expect(victim.cookie).not.toBe(attacker.cookie);

      const res = await app.request(
        `/api/auth/oauth/${provider}/callback?code=attacker-code&state=${attacker.state}`,
        { headers: { Cookie: victim.cookie } },
      );
      expectRedirectToError(res, "OAUTH_STATE_INVALID");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();

      // The rejected state is consumed: the attacker cannot retry it from their own browser either.
      const retry = await app.request(
        `/api/auth/oauth/${provider}/callback?code=attacker-code&state=${attacker.state}`,
        { headers: { Cookie: attacker.cookie } },
      );
      expectRedirectToError(retry, "OAUTH_STATE_INVALID");
    });
  }

  // Transitional: states minted before binding shipped (in flight across the deploy).
  test("a pre-binding login or activation state restarts its flow without exchanging the code", async () => {
    const unbound = { provider: "google", codeVerifier: "v", nonce: "n" } as const;
    const cases = [
      [{ ...unbound, flow: "login" }, "/api/auth/oauth/google/start"],
      [
        { ...unbound, flow: "activation", token: "a/b" },
        "/api/auth/invitations/a%2Fb/oauth/google/start",
      ],
    ] as const;

    for (const [entry, location] of cases) {
      // With or without a cookie — the old state can never be redeemed, only restarted.
      for (const headers of [{}, { Cookie: BROWSER_COOKIE }] as Record<string, string>[]) {
        await stateStore.set("unbound", entry);
        const callback = "/api/auth/oauth/google/callback?code=attacker-code&state=unbound";

        const res = await googleApp.request(callback, { headers });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(location);
        expect(res.headers.get("set-cookie")).toBeNull();

        // Consumed: presenting it again is a plain invalid state, so a flow restarts at most once.
        expectRedirectToError(
          await googleApp.request(callback, { headers }),
          "OAUTH_STATE_INVALID",
        );
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a pre-binding link state cannot restart (it needs a bearer token) and is rejected", async () => {
    await stateStore.set("unbound-link", {
      flow: "link",
      provider: "google",
      codeVerifier: "v",
      nonce: "n",
      userId: "u",
      schoolId: "s",
    });
    const res = await googleApp.request(
      "/api/auth/oauth/google/callback?code=fake-code&state=unbound-link",
      { headers: { Cookie: BROWSER_COOKIE } },
    );
    expectRedirectToError(res, "OAUTH_STATE_INVALID");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The mock provider's routes read their config from env (no injection seam), so its callback's
  // binding check is exercised here through the same takeAuthorization every callback calls.
  test("every provider's callback enforces the binding through takeAuthorization", async () => {
    for (const provider of ["google", "microsoft", "mock"] as const) {
      const ctx: CallbackContext = {
        db: emptyDb,
        sessionConfig: {} as SessionTokenConfig,
        logger: silentLogger,
        stateStore,
        provider,
        frontendUrl: "https://web.example",
      };
      const probe = new Hono<AppEnv>().get("/take", async (c) => {
        try {
          await takeAuthorization(c, ctx, c.req.query("state")!);
          return c.text("accepted");
        } catch {
          return c.text("rejected");
        }
      });
      const entry = { flow: "login", provider, codeVerifier: "v", nonce: "n" } as const;

      await stateStore.set(`${provider}-bound`, { ...entry, browserBinding: BROWSER_BINDING });
      const accepted = await probe.request(`/take?state=${provider}-bound`, {
        headers: { Cookie: BROWSER_COOKIE },
      });
      expect(await accepted.text()).toBe("accepted");

      await stateStore.set(`${provider}-missing`, { ...entry, browserBinding: BROWSER_BINDING });
      const missing = await probe.request(`/take?state=${provider}-missing`);
      expect(await missing.text()).toBe("rejected");

      await stateStore.set(`${provider}-mismatch`, { ...entry, browserBinding: BROWSER_BINDING });
      const mismatch = await probe.request(`/take?state=${provider}-mismatch`, {
        headers: { Cookie: `${OAUTH_BINDING_COOKIE_NAME}=${"x".repeat(43)}` },
      });
      expect(await mismatch.text()).toBe("rejected");
    }
  });
});

function stubTokenEndpointForBinding(): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ id_token: "anything" }), { status: 200 })),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}
