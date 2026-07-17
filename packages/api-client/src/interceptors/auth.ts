import type { Middleware } from "openapi-fetch";

/**
 * Supplies the bearer token for the active session, or a nullish value when the caller is
 * unauthenticated. Async so the token can come from a refreshing store. Nothing in this repo issues
 * a token yet (see the OpenAPI `bearerAuth` scheme, declared but required by no operation); this
 * interceptor is the seam that activates the moment one does.
 */
export type TokenProvider = () => string | null | undefined | Promise<string | null | undefined>;

/**
 * Client middleware that attaches `Authorization: Bearer <token>` to every outbound request when a
 * token is available, and leaves the request untouched otherwise (public routes stay anonymous).
 */
export function authMiddleware(getToken: TokenProvider): Middleware {
  return {
    async onRequest({ request }) {
      const token = await getToken();
      if (!token) {
        return undefined;
      }
      request.headers.set("Authorization", `Bearer ${token}`);
      return request;
    },
  };
}
