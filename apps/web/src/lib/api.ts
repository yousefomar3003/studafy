import { createApiClient } from "@studafy/api-client";

/**
 * The app-wide, typed API client, generated from the backend's OpenAPI contract (ST-060/ST-061).
 * Import `api` and call `api.GET("/healthz")`, `api.POST(...)`, etc. — every path, parameter, and
 * response is type-checked against the spec, and a non-2xx response throws a typed `ApiError`.
 *
 * The base URL comes from `VITE_API_BASE_URL` (see `.env`), defaulting to the local API.
 *
 * `getToken`/`getSchoolId` are the auth and tenant seams. They return `null` today because nothing
 * issues a session yet; the interceptors inject an `Authorization: Bearer` header and the active
 * `school_id` automatically the moment these start returning a value, with no call-site changes.
 */
export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000",
  // TODO(auth): return the active session token once authentication is implemented.
  getToken: () => null,
  // TODO(tenancy): return the active tenant's school_id once tenant selection exists.
  getSchoolId: () => null,
});
