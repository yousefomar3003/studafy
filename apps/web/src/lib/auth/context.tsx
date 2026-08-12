import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";

import { API_BASE_URL } from "../config";

import type { SessionStatus, SessionStore } from "./session-store";

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
}

export function useAuth(): AuthState {
  const status = useAuthStatus();
  const store = useSessionStore();
  return {
    status,
    isAuthenticated: status === "authenticated",
    isRestoring: status === "restoring",
    sessionId: store.getSessionId(),
  };
}

/** The OAuth providers the API exposes browser-redirect flows for. */
export const OAUTH_PROVIDERS = {
  google: "/api/auth/oauth/google/start",
  microsoft: "/api/auth/oauth/microsoft/start",
} as const;

export type OAuthProvider = keyof typeof OAUTH_PROVIDERS;

/**
 * Begins a browser-redirect OAuth login: navigates the whole page to the provider's start endpoint,
 * which 302s to the identity provider and, on success, back to `/auth/callback` with the HttpOnly
 * refresh cookie set. A full-page navigation is required (the flow carries state across origins),
 * which is why a pending return-to must live in `sessionStorage` (`return-to.ts`) rather than in
 * memory. Does not touch the return-to itself — the `RequireAuth` guard set it before landing here,
 * and the callback falls back to the portal when none is pending.
 */
export function useOAuthLogin(): (provider: OAuthProvider) => void {
  return (provider) => {
    // eslint-disable-next-line security/detect-object-injection -- `provider` is a closed union of constant map keys
    window.location.assign(`${API_BASE_URL}${OAUTH_PROVIDERS[provider]}`);
  };
}
