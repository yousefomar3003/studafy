import { createSessionStore } from "../auth";

import type { SessionStore, SessionTokens } from "../auth";

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

/**
 * A restored session store whose access token carries `roles`, for rendering pages that read
 * `useAuth()` under an `AuthProvider`. The token is unsigned — the web app only ever decodes it
 * for UX, never verifies it.
 */
export async function createTestSessionStore(roles: readonly string[]): Promise<SessionStore> {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ sub: "user-1", roles }),
        expiresAt: Date.now() + 3_600_000,
        sessionId: "session-1",
      }),
      logout: async () => undefined,
    },
  });
  await store.restore();
  return store;
}

/** A `GET /api/account/profile` response body for page tests. */
export const TEST_PROFILE = {
  user_id: "user-1",
  display_name: "Fatima Al-Sabah",
  email: "fatima@example.edu",
  school: { id: "school-1", name: "Al-Noor Academy" },
};
