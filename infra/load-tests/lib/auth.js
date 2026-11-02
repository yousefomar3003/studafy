// Credential acquisition for every scenario.
//
// Studafy has no password login (docs/security/JWT_verification_architecture.md: "No login,
// logout, or refresh endpoints [mint a token for a real user] ... nothing in the API mints a token
// for a real user" was true when written; login now exists, but only as OIDC — Google/Microsoft, or
// a "mock" provider that mirrors them for dev/E2E). There is no username+password endpoint anywhere
// this suite could script directly.
//
// Two modes, selected by AUTH_MODE:
//
//   "token-pool" (default) — read pre-minted access tokens from a data file. This is the ONLY mode
//   that scales to 5,000 concurrent identities and the only one that can ever run against staging,
//   because of the next paragraph.
//
//   "mock-oauth" — drive the real `/api/auth/oauth/mock/start` → mock IdP → `/api/auth/oauth/mock/
//   callback` → `/api/auth/refresh` round trip that Playwright/Flutter E2E also use. This is
//   LOCAL/DEV ONLY and cannot be pointed at staging: `getMockOAuthConfig()`
//   (apps/api/src/modules/auth/oauth/mock-config.ts) returns null whenever `NODE_ENV` or `APP_ENV`
//   is "production", and staging's own task definition
//   (infra/deploy/ecs/api/task-definition.json.tpl:16) hardcodes `NODE_ENV=production` for every
//   environment it deploys, staging included — the API will 404 the mock routes there, and
//   apps/api/src/env.ts:271-277 additionally makes the API *refuse to boot at all* if
//   `MOCK_OAUTH_ISSUER_URL` is ever set alongside a production-shaped `NODE_ENV`/`APP_ENV`. That is
//   a deliberate safety rail this suite must not route around. See docs/testing/
//   load-test-scenarios.md's "Credentials" section for what actually has to exist before a
//   token-pool run against staging is possible.
//
// Token-pool data file shape (one array of these per role — see seed/generate-local-fixtures.ts
// for how the bundled examples in ../data/ were produced):
//   { "email": "...", "accessToken": "...", "schoolId": "...", ...role-specific fields }

import http from "k6/http";

const AUTH_MODE = __ENV.AUTH_MODE || "token-pool";

/** Read the bearer token straight off a token-pool record. Fails loudly on a stale/empty pool. */
export function tokenFromPool(record) {
  if (!record || !record.accessToken) {
    throw new Error(
      "No accessToken on this record — token-pool data is missing or stale. " +
        "See docs/testing/load-test-scenarios.md's Credentials section.",
    );
  }
  return record.accessToken;
}

/**
 * Log in as `loginHint` (an email that already has a `mock` app.oauth_identities row) via the real
 * mock-OAuth browser round trip, and return a fresh access token. Memoized per VU for the life of
 * the VU — k6 gives each VU its own JS module instance, so this module-level cache is naturally
 * per-VU, not shared or racy.
 */
const vuTokenCache = {};

export function loginViaMockOAuth(baseUrl, loginHint) {
  if (vuTokenCache[loginHint]) return vuTokenCache[loginHint];

  const startRes = http.get(
    `${baseUrl}/api/auth/oauth/mock/start?login_hint=${encodeURIComponent(loginHint)}`,
    { tags: { endpoint: "auth_setup", name: "mock_oauth_start" } },
  );
  // The final hop lands on FRONTEND_URL, which this suite has no reason to know or reach — the
  // refresh cookie was already set by the callback handler before that redirect, which is the only
  // side effect this helper actually needs.
  if (startRes.status >= 400 && startRes.status !== 404) {
    throw new Error(
      `mock OAuth start failed for ${loginHint}: ${startRes.status} ${startRes.status_text}. ` +
        "Is MOCK_OAUTH_ISSUER_URL configured on the target, and does this email have a " +
        "mock oauth_identities row?",
    );
  }

  const refreshRes = http.post(`${baseUrl}/api/auth/refresh`, null, {
    headers: { "Content-Type": "application/json" },
    tags: { endpoint: "auth_setup", name: "mock_oauth_refresh" },
  });
  if (refreshRes.status !== 200) {
    throw new Error(
      `mock OAuth refresh failed for ${loginHint}: ${refreshRes.status} ${refreshRes.body}`,
    );
  }

  const token = refreshRes.json("access_token");
  vuTokenCache[loginHint] = token;
  return token;
}

/** Resolve an access token for one identity record, per AUTH_MODE. */
export function resolveAccessToken(baseUrl, record) {
  if (AUTH_MODE === "mock-oauth") return loginViaMockOAuth(baseUrl, record.email);
  return tokenFromPool(record);
}

export { AUTH_MODE };
