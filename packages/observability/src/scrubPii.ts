import type { Breadcrumb, ErrorEvent } from "@sentry/bun";

/**
 * Word roots that mark a field as personal data or a credential, applied to any key encountered
 * while scrubbing a Sentry event. Starts from the web client's own list
 * (`apps/web/src/lib/monitoring/scrub-pii.ts`, which in turn mirrors
 * `packages/config/rules/no-analytics-pii.js`) and is deliberately stricter: a backend error's
 * context can carry a raw request header, a DB row or a provider payload, none of which the
 * browser ever sees. Kept as a separate runtime copy rather than a shared import, the same
 * lint-time/runtime and browser/server boundary reasoning the web copy documents.
 */
const PII_ROOTS = new Set([
  "email",
  "mail",
  "phone",
  "mobile",
  "address",
  "ssn",
  "national",
  "password",
  "passwd",
  "secret",
  "token",
  "jwt",
  "bearer",
  "otp",
  "pin",
  "credential",
  "credentials",
  "key",
  "cookie",
  "cookies",
  "authorization",
  "auth",
  "session",
  "signature",
  "ip",
  "dob",
  "birth",
  "name",
  "username",
  "iban",
  "card",
  "cvv",
  "body",
  // School-defined records (docs/modules/student-records.md): a revealed or entered answer, an
  // ID or medical field, and the sealed form of one never belong in an error event.
  "passport",
  "medical",
  "answer",
  "answers",
  "reveal",
  "revealed",
  "ciphertext",
]);

const REDACTED = "[Redacted]";

/**
 * Value-level patterns, for PII that hides inside free text rather than behind a key: an error
 * message quoting the offending row (`duplicate key (email)=(…)`), a log line naming a recipient.
 * Deliberately broad — a redacted timestamp in a message is a small debugging cost, a leaked
 * guardian's phone number is not.
 */
const TEXT_PATTERNS: readonly RegExp[] = [
  // Email addresses.
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  // JWTs (header.payload.signature, base64url) and bearer credentials.
  /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g,
  /\bBearer\s+\S+/gi,
  // International phone numbers ("+966 50 123 4567") and bare 8–15 digit runs (local mobiles,
  // national ids). A run bordered by a hyphen or word character is left alone, so an all-digit UUID
  // group ("…-426614174000") or an id suffix is not mistaken for a phone number.
  /\+\d[\d\s-]{6,}\d/g,
  /(?<![\w-])\d{8,15}(?![\w-])/g,
  // Spaced local formats ("050 123 4567", "050-123-4567").
  /\b0\d{1,2}[\s-]\d{3}[\s-]\d{4}\b/g,
];

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

/** Redacts email/phone/token-shaped substrings in a free-text value. */
export function redactPiiText(text: string): string {
  return TEXT_PATTERNS.reduce((result, pattern) => result.replace(pattern, REDACTED), text);
}

/**
 * Redacts PII-shaped keys anywhere in an arbitrarily nested value (an event's `extra`/`contexts`,
 * a breadcrumb's `data`, ...), and PII-shaped substrings in every string left behind. Everything
 * else — ids, enums, counts, status codes — passes through unchanged, which is what keeps a
 * captured error's shape useful for debugging.
 */
export function redactPii<T>(value: T): T {
  if (typeof value === "string") {
    return redactPiiText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPii(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        isPiiKey(key) ? REDACTED : redactPii(entryValue),
      ]),
    ) as T;
  }
  return value;
}

/** Strips the query string and fragment: either can carry a token or an email. */
function stripQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * `beforeSend` hook wired into `Sentry.init` (errorMonitoring.ts). Verified by `scrubPii.test.ts`.
 *
 * - The user is reduced to `{ id }` — never an email, username or IP.
 * - The request is reduced to method + path. Headers (Authorization, Cookie, X-CSRF-Token),
 *   cookies, query string and body are dropped outright rather than key-scrubbed: nothing in them
 *   is worth the risk of a header name this list did not anticipate.
 * - `extra`, `contexts`, the message and every exception value go through `redactPii`.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : undefined;
  }

  if (event.request) {
    event.request = {
      ...(event.request.method ? { method: event.request.method } : {}),
      ...(event.request.url ? { url: stripQuery(event.request.url) } : {}),
    };
  }

  if (event.extra) {
    event.extra = redactPii(event.extra);
  }
  if (event.contexts) {
    event.contexts = redactPii(event.contexts);
  }
  if (event.message) {
    event.message = redactPiiText(event.message);
  }
  if (event.logentry) {
    event.logentry = redactPii(event.logentry);
  }
  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((exception) =>
      exception.value === undefined
        ? exception
        : { ...exception, value: redactPiiText(exception.value) },
    );
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((breadcrumb) => scrubBreadcrumb(breadcrumb));
  }

  return event;
}

/** `beforeBreadcrumb` hook — scrubs a breadcrumb's message and `data` before it joins an event. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return {
    ...breadcrumb,
    ...(breadcrumb.message === undefined ? {} : { message: redactPiiText(breadcrumb.message) }),
    ...(breadcrumb.data === undefined ? {} : { data: redactPii(breadcrumb.data) }),
  };
}
