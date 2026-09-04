/**
 * Fixed ports for the critical-journeys E2E stack (ST-246), the single source of truth shared by
 * `global-setup.ts`, `global-teardown.ts`, `playwright.critical.config.ts`, and every spec.
 *
 * Fixed rather than dynamically allocated — same choice the `mobile-api-client` CI job makes for its
 * own API instance (`PORT=38080`) — so nothing needs a runtime handshake to discover where the stack
 * ended up: the config's `webServer` env block, the global setup's spawned processes, and a spec's
 * `request.get(API_BASE_URL + ...)` all read the same literal constants. Postgres/Redis reuse
 * `db/compose.yml`'s own already-fixed ports (54329/6390) rather than inventing new ones.
 */

export const API_PORT = 38070;
export const FAKE_ANTHROPIC_PORT = 38071;
export const WEB_PORT = 4174;

export const API_BASE_URL = `http://127.0.0.1:${API_PORT}`;
export const FAKE_ANTHROPIC_BASE_URL = `http://127.0.0.1:${FAKE_ANTHROPIC_PORT}`;
export const WEB_BASE_URL = `http://127.0.0.1:${WEB_PORT}`;

export const MOCK_OAUTH_ISSUER_URL = `${API_BASE_URL}/mock-idp`;
export const MOCK_OAUTH_REDIRECT_URI = `${API_BASE_URL}/api/auth/oauth/mock/callback`;
