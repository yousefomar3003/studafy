import type { Middleware } from "openapi-fetch";

/**
 * Supplies the active tenant's `school_id`, or a nullish value when no tenant is selected. Async so
 * it can read from an auth/session store. No current route is tenant-scoped, so this interceptor is
 * inert in practice today; it is the seam that carries the tenant boundary onto the wire the moment
 * a `/{school_id}/…` route or a tenant-filtered list endpoint lands.
 */
export type SchoolIdProvider = () => string | null | undefined | Promise<string | null | undefined>;

/** Query parameter used to pin the tenant when a route does not scope it in the path. */
export const TENANT_QUERY_PARAM = "school_id";

/**
 * Client middleware that injects the active tenant's `school_id` into every outbound request.
 *
 * A route that scopes the tenant in its path (`/{school_id}/…`) already carries the id — openapi-fetch
 * substitutes it from `params.path` before this runs — so we add nothing in that case. Otherwise the
 * id is appended as the `school_id` query parameter, unless the caller already pinned it explicitly.
 */
export function tenantMiddleware(getSchoolId: SchoolIdProvider): Middleware {
  return {
    async onRequest({ request }) {
      const schoolId = await getSchoolId();
      if (!schoolId) {
        return undefined;
      }

      const url = new URL(request.url);
      // Path already scoped to this tenant, or the caller pinned it — do not duplicate the boundary.
      if (url.pathname.includes(schoolId) || url.searchParams.has(TENANT_QUERY_PARAM)) {
        return undefined;
      }

      url.searchParams.set(TENANT_QUERY_PARAM, schoolId);
      // Rebuild from the existing request so method, headers, and body are preserved verbatim.
      return new Request(url.toString(), request);
    },
  };
}
