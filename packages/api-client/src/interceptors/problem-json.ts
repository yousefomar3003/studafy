import { ApiError } from "../errors";

import type { Middleware } from "openapi-fetch";

/**
 * Client middleware that turns any non-2xx response into a thrown, typed {@link ApiError}.
 *
 * openapi-fetch normally hands errors back as `{ error }`; this middleware runs first (in the
 * response phase, which openapi-fetch leaves un-caught) and throws instead, so a caller can
 * `try { await client.GET(...) } catch (e) { if (e instanceof ApiError) … }` and reach `request_id`,
 * `code`, `detail`, and `instance` directly. Successful responses pass through untouched, so
 * openapi-fetch still parses and types the body.
 */
export function problemJsonMiddleware(): Middleware {
  return {
    async onResponse({ response }) {
      if (response.ok) {
        return undefined;
      }
      throw await ApiError.fromResponse(response);
    },
  };
}
