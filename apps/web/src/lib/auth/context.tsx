import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";

import { API_BASE_URL } from "../config";

import { permissionsForRoles } from "./permissions";

import type { SessionStatus, SessionStore } from "./session-store";
import type { Permission } from "@studafy/constants";

const SessionContext = createContext<SessionStore | null>(null);

/**
 * Makes the app-wide session store available to the tree and owns nothing else. The store itself is
 * created once per app instance in `AppProviders` (alongside the query and realtime clients) and
 * passed in; hydration and redirects are the guard's and the auth pages' job, so this provider never
 * navigates and stays router-independent.
 */
export function AuthProvider({ store, children }: PropsWithChildren<{ store: SessionStore }>) {
  return <SessionContext.Provider value={store}>{children}</SessionContext.Provider>;
}

/** Returns the app-wide session store. Throws outside an `AuthProvider`. */
export function useSessionStore(): SessionStore {
  const store = useContext(SessionContext);
  if (store === null) {
    throw new Error("useSessionStore must be used within an AuthProvider");
  }
  return store;
}

/**
 * Subscribes to the session status. Re-renders only on status transitions because `getStatus`
 * returns a stable primitive snapshot (the same idiom as `useRealtimeConnection`).
 */
export function useAuthStatus(): SessionStatus {
  const store = useSessionStore();
  const subscribe = useMemo(() => store.subscribe.bind(store), [store]);
  const getStatus = useMemo(() => store.getStatus.bind(store), [store]);
  return useSyncExternalStore(subscribe, getStatus);
}

/** Convenience view over the session status for components that need more than the primitive. */
export interface AuthState {
  readonly status: SessionStatus;
  readonly isAuthenticated: boolean;
  readonly isRestoring: boolean;
  readonly sessionId: string | null;
  /** The held token's `roles` claim. Routing/UX data only — see `decodeAccessTokenRoles`. */
  readonly roles: readonly string[];
  /** The held token's `sub` claim (the caller's own user id). UX data only — see `decodeAccessTokenUserId`. */
  readonly userId: string | null;
}

export function useAuth(): AuthState {
  const status = useAuthStatus();
  const store = useSessionStore();
  return {
    status,
    isAuthenticated: status === "authenticated",
    isRestoring: status === "restoring",
    sessionId: store.getSessionId(),
    roles: store.getRoles(),
    userId: store.getUserId(),
  };
}

/**
 * The permission set granted by the current session's roles — see `permissionsForRoles` for what
 * this can and cannot be used for. Memoized on the roles array, which is only ever replaced (not
 * mutated) by the session store, so identity comparison is enough to skip recomputation on renders
 * that don't follow a rotation.
 */
export function usePermissions(): ReadonlySet<Permission> {
  const { roles } = useAuth();
  return useMemo(() => permissionsForRoles(roles), [roles]);
}

/**
 * The OAuth providers the API exposes browser-redirect flows for. "mock" only ever answers (see
 * mock-config.ts) when the API's own MOCK_OAUTH_ISSUER_URL is set, which is never true in a real
 * deployment — see SHOW_MOCK_LOGIN's doc comment (lib/config.ts) for why the button can still be
 * gated separately on the client.
 */
export const OAUTH_PROVIDERS = {
  google: "/api/auth/oauth/google/start",
  microsoft: "/api/auth/oauth/microsoft/start",
  mock: "/api/auth/oauth/mock/start",
} as const;

export type OAuthProvider = keyof typeof OAUTH_PROVIDERS;

/**
 * Begins a browser-redirect OAuth login: navigates the whole page to the provider's start endpoint,
 * which 302s to the identity provider and, on success, back to `/auth/callback` with the HttpOnly
 * refresh cookie set. A full-page navigation is required (the flow carries state across origins),
 * which is why a pending return-to must live in `sessionStorage` (`return-to.ts`) rather than in
 * memory. Does not touch the return-to itself — the `RequireAuth` guard set it before landing here,
 * and the callback falls back to the portal when none is pending.
 *
 * `loginHint` is forwarded as `?login_hint=` and is meaningful only for the "mock" provider — it
 * selects which seeded persona's email the mock IdP signs the token for (mock-idp.ts); Google and
 * Microsoft ignore an unrecognized query param on their own authorization endpoints.
 */
export function useOAuthLogin(): (provider: OAuthProvider, loginHint?: string) => void {
  return (provider, loginHint) => {
    // eslint-disable-next-line security/detect-object-injection -- `provider` is a closed union of constant map keys
    const url = new URL(`${API_BASE_URL}${OAUTH_PROVIDERS[provider]}`);
    if (loginHint) url.searchParams.set("login_hint", loginHint);
    window.location.assign(url.toString());
  };
}
