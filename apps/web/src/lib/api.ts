import { createApiClient } from "@studafy/api-client";

import { sessionStore } from "./auth";
import { API_BASE_URL } from "./config";

/**
 * The app-wide, typed API client, generated from the backend's OpenAPI contract (ST-060/ST-061).
 * Import `api` and call `api.GET("/healthz")`, `api.POST(...)`, etc. — every path, parameter, and
 * response is type-checked against the spec, and a non-2xx response throws a typed `ApiError`.
 *
 * `getToken`/`getSchoolId` are the auth and tenant seams. `getToken` resolves the in-memory access
 * token from the session store, which rotates the HttpOnly refresh cookie transparently before the
 * token expires; `getSchoolId` returns `null` until tenant selection exists. The interceptors
 * inject an `Authorization: Bearer` header and the active `school_id` automatically.
 */
export const api = createApiClient({
  baseUrl: API_BASE_URL,
  getToken: () => sessionStore.getToken(),
  // TODO(tenancy): return the active tenant's school_id once tenant selection exists.
  getSchoolId: () => null,
});
