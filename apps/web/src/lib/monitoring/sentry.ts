import * as Sentry from "@sentry/react";

import { getReleaseVersion, getSentryDsn, getSentryEnvironment } from "./config";
import { scrubBreadcrumb, scrubEvent } from "./scrub-pii";

/**
 * The one seam the rest of the app reaches through for error monitoring — nothing outside this
 * directory imports `@sentry/react` directly, the same instrumentation-seam idiom `lib/analytics`
 * uses for its own vendor. Every export below degrades to a no-op when `SENTRY_DSN` is unset (local
 * dev, the `containers.yml` validation build), so the app behaves identically with or without a
 * project wired up.
 *
 * Error monitoring only — no performance tracing is configured (no `tracesSampleRate`, no
 * `browserTracingIntegration`), which is out of scope for this ticket.
 */
export function initMonitoring(): void {
  const dsn = getSentryDsn();
  if (!dsn) {
    return;
  }
  Sentry.init({
    dsn,
    environment: getSentryEnvironment(),
    release: getReleaseVersion(),
    // Sentry's own PII collection (request cookies/headers, the user's IP) stays off by default;
    // `scrubEvent`/`scrubBreadcrumb` are the belt-and-braces layer over whatever the app itself
    // attaches to an event.
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}

/**
 * Reports a caught error. Called from the app-level `ErrorBoundary` and the router's `RouteError`
 * (see their own doc comments). A no-op when monitoring is disabled; callers keep their own
 * `console.error` for that case rather than this module logging on their behalf.
 */
export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  if (!getSentryDsn()) {
    return;
  }
  Sentry.captureException(error, extra ? { extra } : undefined);
}

/**
 * Sets or clears the Sentry user context — the session's own id only, matching `AuthState.userId`
 * (`lib/auth/context.tsx`). Kept in sync with the session by `useSyncMonitoringUser`.
 */
export function setMonitoringUser(userId: string | null): void {
  if (!getSentryDsn()) {
    return;
  }
  Sentry.setUser(userId ? { id: userId } : null);
}

const TEST_ERROR_QUERY_PARAM = "sentry-test";

/**
 * Post-deploy verification hook for the "thrown test error appears in Sentry with a readable
 * stack" acceptance criterion: visiting any URL with `?sentry-test` throws, uncaught, on the next
 * tick — outside React and outside `captureException` entirely, so Sentry's own global
 * `window.onerror`/`unhandledrejection` handlers (installed by `Sentry.init` regardless of this
 * app's own wiring) report it exactly the way a real unhandled error would. A no-op for every
 * normal page load. `scheduleThrow` is a test seam (default: `window.setTimeout`) so the throw
 * itself can be asserted synchronously rather than via a real timer.
 */
export function triggerTestErrorFromQueryParam(
  search: string,
  scheduleThrow: (fn: () => void) => void = (fn) => window.setTimeout(fn),
): void {
  if (!new URLSearchParams(search).has(TEST_ERROR_QUERY_PARAM)) {
    return;
  }
  scheduleThrow(() => {
    throw new Error(`Sentry verification test error (triggered via ?${TEST_ERROR_QUERY_PARAM})`);
  });
}
