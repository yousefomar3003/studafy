/**
 * App-wide environment-derived configuration, single-sourced so every client (the bearer API
 * client in `lib/api.ts`, the cookie-authenticated session client in `lib/auth/api.ts`) reads the
 * same origin. Values come from Vite's `import.meta.env`; see the root `.env` (`VITE_*` keys).
 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

/** Contact address for the marketing site. `undefined` when not configured — see vite-env.d.ts. */
export const MARKETING_CONTACT_EMAIL = import.meta.env.VITE_MARKETING_CONTACT_EMAIL;

/**
 * Cloudflare Turnstile site key for the school registration form. Falls back to Cloudflare's
 * publicly documented always-passing test key (used for local/CI testing by design, not a
 * fabricated bypass — https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
 * so the widget still renders and produces a token when no real site key is configured.
 */
export const TURNSTILE_SITE_KEY =
  import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "1x00000000000000000000AA";

/**
 * Shows the "Continue with Mock" sign-in option (LoginPage.tsx, InvitePage.tsx) — the dev/E2E-only
 * OAuth provider backed by `apps/api/src/dev/mock-idp.ts`, inert unless the API's own
 * `MOCK_OAUTH_ISSUER_URL` is also set (mock-config.ts). `import.meta.env.DEV` covers `vite dev`;
 * `VITE_ENABLE_MOCK_AUTH=true` covers the production build the critical-journeys E2E suite runs
 * against (playwright.critical.config.ts) — a real deployment never sets that variable, so the
 * button never renders in a real deployment even though the build is otherwise a production build.
 */
export const SHOW_MOCK_LOGIN =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_MOCK_AUTH === "true";
