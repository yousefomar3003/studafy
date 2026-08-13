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
