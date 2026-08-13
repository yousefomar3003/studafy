/**
 * App-wide environment-derived configuration, single-sourced so every client (the bearer API
 * client in `lib/api.ts`, the cookie-authenticated session client in `lib/auth/api.ts`) reads the
 * same origin. Values come from Vite's `import.meta.env`; see the root `.env` (`VITE_*` keys).
 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

/** Contact address for the marketing site. `undefined` when not configured — see vite-env.d.ts. */
export const MARKETING_CONTACT_EMAIL = import.meta.env.VITE_MARKETING_CONTACT_EMAIL;
