import createClient, { type Client } from "openapi-fetch";

import { authMiddleware, type TokenProvider } from "./interceptors/auth";
import { problemJsonMiddleware } from "./interceptors/problem-json";
import { sanitizeMiddleware, type SanitizeOptions } from "./interceptors/sanitize";
import { tenantMiddleware, type SchoolIdProvider } from "./interceptors/tenant";

import type { paths } from "./generated-types";

/** Options for {@link createApiClient}. */
export interface ApiClientOptions {
  /** API origin, e.g. `http://localhost:3000`. */
  readonly baseUrl: string;
  /** Supplies the bearer token; omit for an anonymous client. */
  readonly getToken?: TokenProvider;
  /** Supplies the active tenant's `school_id`; omit for an untenanted client. */
  readonly getSchoolId?: SchoolIdProvider;
  /** Enable request-body sanitization: `true` for defaults, or an options object with an allowlist. */
  readonly sanitize?: boolean | SanitizeOptions;
  /** Override the fetch implementation (tests inject a mock; production uses the platform default). */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Cookie policy for requests. `"include"` is required when the client runs on a different origin
   * than the API yet still relies on a cookie credential (the web session's HttpOnly refresh
   * cookie). Omitted for same-origin or bearer-only clients. The literal union mirrors
   * `RequestCredentials` without pulling the DOM lib into this package's `ES2022` target.
   */
  readonly credentials?: "omit" | "same-origin" | "include";
}

/** A fully-typed client whose method surface is derived from the OpenAPI document. */
export type ApiClient = Client<paths>;

/**
 * Builds a typed fetch client for the Studafy API from the generated `paths`.
 *
 * Interceptors are registered in request order — auth, then tenant, then (optional) sanitizer — and
 * the problem+json interceptor last, so it owns the response phase and throws a typed {@link ApiError}
 * on any non-2xx. Every method call is typed end-to-end against the OpenAPI contract; no runtime
 * client beyond openapi-fetch's native-fetch wrapper is introduced.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });

  if (options.getToken) {
    client.use(authMiddleware(options.getToken));
  }
  if (options.getSchoolId) {
    client.use(tenantMiddleware(options.getSchoolId));
  }
  if (options.sanitize) {
    client.use(sanitizeMiddleware(options.sanitize === true ? {} : options.sanitize));
  }
  client.use(problemJsonMiddleware());

  return client;
}
