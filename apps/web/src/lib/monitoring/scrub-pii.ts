import type { Breadcrumb, ErrorEvent } from "@sentry/react";

/**
 * Word roots that mark a field as personal data, applied to any key encountered while scrubbing a
 * Sentry event. Deliberately mirrors the roots in `packages/config/rules/no-analytics-pii.js` — the
 * two lists solve the same problem (PII-shaped fields leaking into telemetry) for different
 * pipelines, one a static lint check on `track()` payloads and this one a runtime redactor over
 * whatever an error's context happens to carry, so they stay separate rather than sharing an import
 * across a lint-time/runtime boundary.
 */
const PII_ROOTS = new Set([
  "email",
  "mail",
  "phone",
  "mobile",
  "address",
  "ssn",
  "password",
  "passwd",
  "secret",
  "token",
  "cookie",
  "cookies",
  "authorization",
  "ip",
  "dob",
  "birth",
  "name",
]);

const REDACTED = "[Redacted]";

function segments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

function isPiiKey(key: string): boolean {
  return segments(key).some((segment) => PII_ROOTS.has(segment));
}

/**
 * Redacts PII-shaped keys anywhere in an arbitrarily nested value (a breadcrumb's `data`, an
 * event's `extra`, request bodies/query strings, ...). Everything else — ids, enums, counts,
 * timestamps — passes through unchanged, which is what keeps a captured error's stack and shape
 * useful for debugging.
 */
export function redactPii<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactPii(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isPiiKey(key) ? REDACTED : redactPii(entryValue);
    }
    return result as T;
  }
  return value;
}

/**
 * Reduces a Sentry user context down to the session's own id — never an email or name, which the
 * access token's claims never carry anyway (see `access-token-claims.ts`) but which `@sentry/react`
 * would otherwise infer from the page (e.g. a logged-in form's `autocomplete` fields) if left to its
 * default `sendDefaultPii` behavior.
 */
function scrubUser(event: ErrorEvent): void {
  if (!event.user) {
    return;
  }
  event.user = event.user.id ? { id: event.user.id } : undefined;
}

/**
 * `beforeSend` hook wired into `Sentry.init` (`sentry.ts`). Verified by `scrub-pii.test.ts` — the
 * acceptance criterion this satisfies ("PII scrubbers verified").
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  scrubUser(event);

  if (event.request) {
    event.request = redactPii(event.request);
  }
  if (event.extra) {
    event.extra = redactPii(event.extra);
  }
  if (event.contexts) {
    event.contexts = redactPii(event.contexts);
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((breadcrumb) => scrubBreadcrumb(breadcrumb));
  }

  return event;
}

/** `beforeBreadcrumb` hook — scrubs a breadcrumb's own `data` before it ever joins an event. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (!breadcrumb.data) {
    return breadcrumb;
  }
  return { ...breadcrumb, data: redactPii(breadcrumb.data) };
}
