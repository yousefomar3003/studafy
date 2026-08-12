/**
 * Web auth session layer.
 *
 * Owns the browser session against the Studafy API: an in-memory access token (never stored on
 * disk or in a cookie), transparent rotation of the HttpOnly refresh cookie before expiry, OAuth
 * redirect handling via `/auth/callback`, and the signed-out / session-expired UX with return-to
 * routing. See `apps/web/docs/web-auth-flow.md` for the full flow.
 *
 * - {@link sessionStore} — the app-wide store, wired to the cookie-authenticated API client.
 * - {@link createSessionStore} — the framework-agnostic factory (tests build their own).
 * - {@link AuthProvider} / {@link useAuth} — React wiring and status hook.
 * - {@link useOAuthLogin} — kicks off a browser-redirect OAuth login.
 * - {@link RequireAuth} — the route guard for authenticated groups.
 * - {@link setReturnTo} / {@link consumeReturnTo} — deep-link restoration across the OAuth trip.
 * - {@link decodeAccessTokenRoles} / {@link resolveRoleHome} — first-run, role-based home routing.
 */
export { createSessionStore } from "./session-store";
export type {
  SessionRefreshClient,
  SessionStatus,
  SessionStore,
  SessionStoreOptions,
  SessionTokens,
} from "./session-store";

export { createAuthRefreshClient, authRefreshClient } from "./api";
export type { AuthRefreshClientOptions } from "./api";

export {
  AuthProvider,
  OAUTH_PROVIDERS,
  useAuth,
  useAuthStatus,
  useOAuthLogin,
  useSessionStore,
} from "./context";
export type { AuthState, OAuthProvider } from "./context";

export { RequireAuth } from "./require-auth";

export {
  clearReturnTo,
  consumeReturnTo,
  getReturnTo,
  isInternalPath,
  setReturnTo,
} from "./return-to";

export { decodeAccessTokenRoles } from "./access-token-claims";
export { resolveRoleHome } from "./role-home";

import { authRefreshClient } from "./api";
import { createSessionStore } from "./session-store";

/** The app-wide session store. `lib/api.ts`'s token seam and the realtime handshake read through it. */
export const sessionStore = createSessionStore({ refreshClient: authRefreshClient });
