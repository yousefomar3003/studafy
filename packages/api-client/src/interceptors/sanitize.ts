import type { Middleware } from "openapi-fetch";

/**
 * Options for the payload sanitizer.
 *
 * The sanitizer strips un-normalized nested sub-objects from a JSON request body before it goes on
 * the wire — a client-side guard against sending a denormalized graph where the backend expects flat,
 * third-normal-form attributes. A route that legitimately accepts a composite nested relational
 * payload (e.g. the ERPNext webhook's `data` document) names those top-level keys in `allowNested` so
 * they survive.
 */
export interface SanitizeOptions {
  /** Top-level keys whose nested-object values are a legitimate composite payload and must survive. */
  readonly allowNested?: readonly string[];
}

/** A value is an un-normalized nested sub-object iff it is a non-null, non-array plain object. */
function isPlainNestedObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a shallow copy of `payload` with every un-normalized nested sub-object removed, except for
 * the top-level keys named in `allowNested`. Primitives, arrays, and allow-listed nested objects are
 * preserved. Exported for direct unit testing.
 */
export function stripUnnormalizedNesting(
  payload: Record<string, unknown>,
  allowNested: ReadonlySet<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (isPlainNestedObject(value) && !allowNested.has(key)) {
      continue;
    }
    // eslint-disable-next-line security/detect-object-injection -- key is an own enumerable key from Object.entries of the caller's payload, not attacker-controlled indexing.
    result[key] = value;
  }
  return result;
}

/**
 * Client middleware that strips un-normalized nested sub-objects from JSON request bodies.
 *
 * Opt-in and configurable, not on by default: silently rewriting every body would corrupt routes
 * that legitimately carry nested relational payloads. Enable it per client with an `allowNested`
 * allowlist for those routes. Non-JSON and body-less requests pass through untouched.
 */
export function sanitizeMiddleware(options: SanitizeOptions = {}): Middleware {
  const allowNested = new Set(options.allowNested ?? []);
  return {
    async onRequest({ request }) {
      const contentType = request.headers.get("content-type") ?? "";
      if (
        !contentType.includes("application/json") ||
        request.method === "GET" ||
        request.method === "HEAD"
      ) {
        return undefined;
      }

      let payload: unknown;
      try {
        payload = await request.clone().json();
      } catch {
        return undefined; // Not JSON we can parse; leave the request untouched.
      }
      if (!isPlainNestedObject(payload)) {
        return undefined; // Arrays / primitives at the top level: nothing to normalize.
      }

      const sanitized = stripUnnormalizedNesting(payload, allowNested);
      // Rebuild from the existing request so method and headers are preserved; body is replaced.
      return new Request(request, { body: JSON.stringify(sanitized) });
    },
  };
}
