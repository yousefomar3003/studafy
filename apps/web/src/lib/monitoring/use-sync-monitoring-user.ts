import { useEffect } from "react";

import { useAuth } from "../auth";

import { setMonitoringUser } from "./sentry";

/**
 * Keeps the Sentry user context aligned with the session's own user id — ids only, matching
 * `AuthState.userId` (`lib/auth/context.tsx`). Cleared on sign-out the same way: `userId` goes
 * `null` when the session store drops its tokens, and this effect re-runs. Mounted once near the
 * root, inside `AuthProvider` (see `AppProviders`), so it observes every session transition.
 *
 * `setUser` defaults to the real `setMonitoringUser` and is a test seam otherwise — the same
 * dependency-injection idiom `createSessionStore` uses for its own clock/timer seams — so
 * `use-sync-monitoring-user.test.ts` can assert against a plain spy instead of mocking the shared
 * `./sentry` module (which every other consumer of `lib/monitoring` also resolves to).
 */
export function useSyncMonitoringUser(
  setUser: (userId: string | null) => void = setMonitoringUser,
): void {
  const { userId } = useAuth();

  useEffect(() => {
    setUser(userId);
  }, [userId, setUser]);
}
