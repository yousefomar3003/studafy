import type { Guide } from "./types";

/**
 * Authentication guide (ST-269).
 *
 * Every claim here is read off the code that enforces it, not the intent that motivated it:
 * apps/api/src/middleware/jwtAuth.ts (the bearer boundary), apps/api/src/modules/auth/delivery.ts
 * (channel-aware token delivery), apps/api/src/modules/auth/routes/returning-user-login-routes.ts
 * and mobile-oauth-routes.ts (the two login paths), and apps/api/src/dev/mock-idp.ts +
 * modules/auth/oauth/mock-config.ts (the local quickstart's mock provider).
 */
export const authGuide: Guide = {
  slug: "auth",
  navTitle: "Authentication",
  title: "Authentication & authorization",
  summary:
    "How a client becomes a bearer of session tokens, and how it stays one. There is no " +
    "password grant — every login is OIDC against Microsoft or Google (or, in development, a mock " +
    "provider).",
  sections: [
    {
      heading: "Model",
      body: [
        "Every session is an RS256 JWT **access token**, short-lived, sent as " +
          "`Authorization: Bearer <token>`, plus a **refresh token** that rotates on every use. A " +
          "presented refresh token is invalidated unconditionally on rotation — re-presenting an " +
          "already-rotated one is treated as theft and revokes the whole token family, ending the " +
          "session it belonged to.",
        "A session has a **channel** — `web`, `mobile`, or `api` — fixed at login and carried " +
          "unchanged through every rotation. It decides how the refresh token is delivered, and " +
          "that decision is never taken from a request header: `web` sessions get it as an " +
          "HttpOnly, `Secure`, `SameSite=Strict` cookie scoped to `/api/auth`, and never see it in " +
          "a response body. `mobile` and `api` sessions get it in the JSON body instead, because a " +
          "native app has no cookie jar worth relying on. A script driving this API directly " +
          'should request `channel: "api"` and treat the response body\'s `refresh_token` as the ' +
          "credential to store.",
        "The access token also carries the caller's `roles`, `school_id` (tenant), and an " +
          "`entitlements_ver` claim. A request whose claim predates the tenant's current " +
          "entitlement version — a subscription just changed — fails closed with 401 " +
          "`AUTH_ENTITLEMENTS_STALE` rather than serving a decision made on stale billing state; " +
          "the fix is the same as an expired token, one call to `POST /api/auth/refresh`.",
      ],
    },
    {
      heading: "Logging in",
      body: [
        "There is no username/password endpoint. A returning user authenticates with an OIDC ID " +
          "token already verified by Microsoft or Google:",
      ],
      blocks: [
        {
          language: "http",
          api: { method: "POST", path: "/api/auth/login/oauth", documented: true },
          code:
            "POST /api/auth/login/oauth\nContent-Type: application/json\n\n" +
            "{\n" +
            '  "id_token": "<verified Microsoft or Google OIDC id_token>",\n' +
            '  "nonce": "<the nonce your authorization request generated>",\n' +
            '  "provider": "microsoft",\n' +
            '  "channel": "api"\n' +
            "}",
        },
      ],
    },
    {
      heading: "Using the token",
      body: ["Send the access token as a bearer credential on every `/api/*` request:"],
      blocks: [
        {
          language: "http",
          code: "GET /api/auth/sessions\nAuthorization: Bearer <access_token>",
        },
      ],
    },
    {
      heading: "Refreshing and logging out",
      body: [
        "`POST /api/auth/refresh` rotates the presented refresh token (cookie for a `web` session, " +
          "`refresh_token` in the body otherwise) for a new pair, and is itself unauthenticated — a " +
          "client reaches it precisely because its access token is gone or expired.",
        "`POST /api/auth/logout` revokes the token family the presented refresh token belongs to " +
          "and clears the cookie. It always answers 200, whether or not the token was valid, " +
          "already revoked, or absent — reporting otherwise would let a caller probe for live " +
          "sessions.",
      ],
      blocks: [
        {
          language: "http",
          api: { method: "POST", path: "/api/auth/refresh", documented: true },
          code: 'POST /api/auth/refresh\n\n{ "refresh_token": "<current refresh token>" }',
        },
        {
          language: "http",
          api: { method: "POST", path: "/api/auth/logout", documented: true },
          code: 'POST /api/auth/logout\n\n{ "refresh_token": "<current refresh token>" }',
        },
      ],
    },
    {
      heading: "Local quickstart",
      body: [
        "Local development and CI mount a third, mock OIDC provider (`apps/api/src/dev/mock-idp.ts`) " +
          "so a client can obtain a real, working session for any seeded persona without a Microsoft " +
          "or Google app registration. It is hard-disabled outside `development`/`test` " +
          "(`isMockOAuthSafeEnvironment` in `modules/auth/oauth/mock-config.ts`) — it does not exist " +
          "as an attack surface in staging or production regardless of configuration.",
        "It needs two environment variables the API does not default, because there is no single " +
          "correct value across every dev machine and CI runner: `MOCK_OAUTH_ISSUER_URL` (where " +
          "`dev/mock-idp.ts` is mounted — the mock provider is served by this same process, at " +
          "`/mock-idp`) and `MOCK_OAUTH_REDIRECT_URI`. Running the API locally on its default port:",
      ],
      blocks: [
        {
          language: "bash",
          code:
            "export MOCK_OAUTH_ISSUER_URL=http://localhost:3000/mock-idp\n" +
            "export MOCK_OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/oauth/mock/callback",
        },
      ],
    },
    {
      heading: "Quickstart: get a session with curl",
      body: [
        "The mobile OAuth routes are a plain JSON request/response round trip — no browser, no " +
          "cookie jar, no custom URI scheme — which makes them the one login path this API exposes " +
          "that a terminal can drive end to end. This is the exact three-call sequence the Flutter " +
          "integration suite (ST-247) automates against the same mock provider.",
        "**1. Start the flow.** The server hands back PKCE parameters and stores the verifier " +
          "itself; the client never sees or needs it.",
      ],
      blocks: [
        {
          language: "bash",
          api: { method: "GET", path: "/api/auth/oauth/mock/mobile-start", documented: true },
          code: "curl -s http://localhost:3000/api/auth/oauth/mock/mobile-start",
        },
        {
          language: "json",
          code: '{\n  "state": "…",\n  "nonce": "…",\n  "code_challenge": "…"\n}',
        },
      ],
    },
    {
      heading: "",
      body: [
        "**2. Trade a login hint for an authorization code at the mock provider.** " +
          "`login_hint` selects which seeded persona to sign in as — any email from " +
          "`docs/database/seeding_guide.md`'s mock-credentials table. The mock provider's " +
          "`/authorize` issues a code immediately (no consent screen) and 302s to whatever " +
          "`redirect_uri` was asked for; `curl -D -` on its own, without `-L`, is what lets you " +
          "read the `code` out of the `Location` header instead of actually following it " +
          "somewhere that doesn't exist.",
      ],
      blocks: [
        {
          language: "bash",
          code:
            "curl -s -D - -o /dev/null \\\n" +
            '  --get "http://localhost:3000/mock-idp/authorize" \\\n' +
            '  --data-urlencode "redirect_uri=http://localhost/callback" \\\n' +
            '  --data-urlencode "response_type=code" \\\n' +
            '  --data-urlencode "state=<state from step 1>" \\\n' +
            '  --data-urlencode "nonce=<nonce from step 1>" \\\n' +
            '  --data-urlencode "code_challenge=<code_challenge from step 1>" \\\n' +
            '  --data-urlencode "code_challenge_method=S256" \\\n' +
            '  --data-urlencode "login_hint=admin@demo.studafy.test" \\\n' +
            "  | grep -i ^location:",
        },
      ],
    },
    {
      heading: "",
      body: [
        "**3. Exchange the code for session tokens.** `channel` is fixed to `mobile` by this route, " +
          "so `refresh_token` comes back in the body — nothing to extract from a cookie jar.",
      ],
      blocks: [
        {
          language: "bash",
          api: {
            method: "POST",
            path: "/api/auth/oauth/mock/mobile-exchange",
            documented: true,
          },
          code:
            "curl -s -X POST http://localhost:3000/api/auth/oauth/mock/mobile-exchange \\\n" +
            '  -H "Content-Type: application/json" \\\n' +
            "  -d '{\n" +
            '    "code": "<code from step 2>",\n' +
            '    "state": "<state from step 1>",\n' +
            '    "nonce": "<nonce from step 1>"\n' +
            "  }'",
        },
        {
          language: "json",
          code:
            '{\n  "access_token": "eyJ...",\n  "token_type": "Bearer",\n  "expires_in": 900,\n' +
            '  "session_id": "…",\n  "refresh_token": "…"\n}',
        },
      ],
    },
    {
      heading: "Failure modes",
      body: [
        "Every rejection here is a normal problem+json response (see the Errors guide) with one of " +
          "these codes:",
      ],
      blocks: [
        {
          language: "text",
          code:
            "401 AUTH_TOKEN_INVALID       — missing/malformed header, bad signature, unknown kid,\n" +
            "                               revoked token, or reused/invalid refresh token\n" +
            "401 AUTH_TOKEN_EXPIRED       — access token's exp has passed; call POST /api/auth/refresh\n" +
            "401 AUTH_ENTITLEMENTS_STALE  — token predates a subscription change; refresh to fix\n" +
            "403 NO_ACCOUNT               — the OAuth identity has no matching app.users row\n" +
            "403 SCHOOL_SUSPENDED         — the identity resolved, but the tenant is suspended",
          errorCodes: [
            "AUTH_TOKEN_INVALID",
            "AUTH_TOKEN_EXPIRED",
            "AUTH_ENTITLEMENTS_STALE",
            "NO_ACCOUNT",
            "SCHOOL_SUSPENDED",
          ],
        },
      ],
    },
  ],
};
