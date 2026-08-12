import { createApiClient } from "@studafy/api-client";

import { API_BASE_URL } from "../config";

import type { SessionRefreshClient, SessionTokens } from "./session-store";

export interface AuthRefreshClientOptions {
  /** Test seam; production uses the platform fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Builds the cookie-authenticated session client.
 *
 * Deliberately separate from the bearer `api` client in `lib/api.ts`: refresh and logout are
 * authenticated by the HttpOnly refresh cookie, not by an access token, and they are reached
 * precisely when the access token is gone. Running them through the bearer client would be a
 * refresh-via-refresh loop — its auth interceptor resolves the token by calling the store, which
 * refreshes via this very endpoint. This client carries no bearer interceptor, so the cookie is the
 * only credential, and `credentials: "include"` makes the browser attach it even though the API
 * origin differs from the web app's (see `ApiClientOptions.credentials`).
 *
 * For web sessions the refresh endpoint deliberately returns no `refresh_token` in the body — the
 * cookie *is* the refresh token (ST-071 delivery rules). This client never sends a body on refresh,
 * so it cannot accidentally read or transmit a refresh token in either direction.
 */
export function createAuthRefreshClient(
  options: AuthRefreshClientOptions = {},
): SessionRefreshClient {
  const authApi = createApiClient({
    baseUrl: API_BASE_URL,
    credentials: "include",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    async refresh(): Promise<SessionTokens> {
      const { data } = await authApi.POST("/api/auth/refresh");
      if (!data) {
        // Unreachable in practice: the problem+json middleware throws a typed `ApiError` on any
        // non-2xx, so `data` is present exactly when the request succeeds.
        throw new Error("Refresh succeeded without a token payload");
      }
      return {
        accessToken: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1_000,
        sessionId: data.session_id,
      };
    },

    async logout(): Promise<void> {
      await authApi.POST("/api/auth/logout");
    },
  };
}

/** The app-wide session client. The store and the bearer client's token seam read through this. */
export const authRefreshClient: SessionRefreshClient = createAuthRefreshClient();
