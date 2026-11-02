/**
 * Minimal, pluggable event tracker. No analytics vendor is wired into this app yet — this is the
 * instrumentation seam a real one (PostHog, Segment, GTM, ...) will sit behind later without any
 * call site changing. Until then, events go to `window.dataLayer` if a consumer has already put one
 * there (the standard GTM/GA4 convention), and to the console in dev so instrumentation is visible
 * while building a flow.
 *
 * Payloads are shallow and JSON-primitive-only by type, which rules out nested objects and arrays —
 * the shapes PII (a profile, a contact record) tends to travel in. This is a shape constraint, not a
 * content one: see `studafy/no-analytics-pii` (`packages/config/rules/no-analytics-pii.js`) for the
 * static check on property names, and `docs/analytics-event-schema.md` for the full event catalog
 * and payload rules.
 */
export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>;

declare global {
  interface Window {
    dataLayer?: Record<string, unknown>[];
  }
}

export function track(event: string, props?: AnalyticsProps): void {
  if (typeof window !== "undefined" && window.dataLayer) {
    window.dataLayer.push({ event, ...props });
    return;
  }
  if (import.meta.env.DEV) {
    console.debug("[analytics]", event, props ?? {});
  }
}
