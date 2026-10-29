import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../db/tenant-tx";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { hasPermission } from "../../middleware/authz";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import { globalSearchResultSchema, searchQuerySchema } from "./schemas";
import { globalSearch, SEARCH_TYPES } from "./service";

import type { GlobalSearchAccess, SearchType } from "./service";
import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { Role } from "@studafy/constants";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function clientIpFrom(c: Context<AppEnv>): string | null {
  const forwarded = c.req.header("X-Forwarded-For");
  if (forwarded === undefined) return null;
  const first = forwarded.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : null;
}

/**
 * Which sections a caller may see: for each type, exactly the gate its own list endpoint applies.
 * Which *rows* come back within a permitted section is decided by row-level security plus the same
 * SQL narrowing that endpoint applies -- see the module header in ./service.ts.
 *
 *   students        GET /api/students                  student:read
 *   users           GET /api/users                     user:read
 *   invoices        GET /api/finance/invoices          billing:read
 *   materials       GET /api/academics/materials       material:read
 *   classes, sections, subjects, grade_levels, academic_years, terms, rooms
 *                   GET /api/academics/*               none: any school member (only writes are
 *                                                      gated); RLS narrows classes and subjects
 *   families        GET /api/families                  PARENT role or parent:link (non-managers see
 *                   GET /api/finance/families          only their own family); billing:read
 *   announcements   GET /api/announcements             notification:manage
 *   events          GET /api/school-events             calendarEvent:read
 *   incidents       /portal/principal/discipline       principalDashboard:view, and the
 *                   GET /api/discipline/incidents      disciplineIncident:read that endpoint needs.
 *                   A caller who is also a PARENT is excluded: that endpoint switches a PARENT to
 *                   their own children's resolved incidents, which is not a search section.
 *   evaluations     GET /api/evaluations               evaluation:read (an INSTRUCTOR: own, shared)
 *   fee_structures  GET /api/finance/fee-structures    billing:update
 *   scholarships    GET /api/finance/scholarships      billing:read
 *   expenses        GET /api/finance/expenses          billing:update
 *   notifications   GET /api/notifications             none: the caller's own inbox (RLS)
 */
export function searchAccessFor(roles: readonly Role[]): GlobalSearchAccess {
  const isParent = roles.includes("PARENT");
  const canManageFamilies = hasPermission(roles, PERMISSIONS.PARENT_LINK);
  const billingRead = hasPermission(roles, PERMISSIONS.BILLING_READ);
  const billingUpdate = hasPermission(roles, PERMISSIONS.BILLING_UPDATE);
  const sections: Record<SearchType, boolean> = {
    students: hasPermission(roles, PERMISSIONS.STUDENT_READ),
    users: hasPermission(roles, PERMISSIONS.USER_READ),
    invoices: billingRead,
    materials: hasPermission(roles, PERMISSIONS.MATERIAL_READ),
    classes: true,
    sections: true,
    subjects: true,
    grade_levels: true,
    academic_years: true,
    terms: true,
    rooms: true,
    families: isParent || canManageFamilies || billingRead,
    announcements: hasPermission(roles, PERMISSIONS.NOTIFICATION_MANAGE),
    events: hasPermission(roles, PERMISSIONS.CALENDAR_EVENT_READ),
    incidents:
      !isParent &&
      hasPermission(roles, PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW) &&
      hasPermission(roles, PERMISSIONS.DISCIPLINE_INCIDENT_READ),
    evaluations: hasPermission(roles, PERMISSIONS.EVALUATION_READ),
    fee_structures: billingUpdate,
    scholarships: billingRead,
    expenses: billingUpdate,
    notifications: true,
  };
  return {
    sections,
    familiesOwnOnly: !canManageFamilies && !billingRead,
    evaluationsOwnSharedOnly: roles.includes("INSTRUCTOR"),
  };
}

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const globalSearchRoute = createRoute({
  method: "get",
  path: "/api/search",
  tags: ["Search"],
  operationId: "globalSearch",
  summary: "Search across the school's people, academics, communication and finance records",
  description:
    "Role-scoped full-text search across twenty record types (`SearchType`), grouped per type " +
    "with a total per type. A type's section is populated only when the caller holds the same " +
    "permission that type's own list endpoint requires -- FINANCE finds invoices but never " +
    "students, INSTRUCTOR the reverse, only school leadership finds discipline incidents, and " +
    "every caller finds their own notifications. Within a permitted section, row-level security " +
    "applies exactly as on that type's list endpoint (a teacher's classes and students are those " +
    "they teach). Matching is accent- and Arabic-letter-form-insensitive, treats the last word as " +
    "a prefix, and falls back to typo-tolerant matching for names. Every call is recorded as a " +
    "'read' audit entry against 'global_search' (query, types, offset, sections run and counts).",
  security: [{ bearerAuth: [] }],
  request: { query: searchQuerySchema },
  responses: standardResponses(
    { 200: { description: "Search hits, grouped by type.", schema: globalSearchResultSchema } },
    [400, 401, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function searchRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.openapi(globalSearchRoute, async (c) => {
    const auth = requireAuth(c);
    const { q, limit, offset, types } = c.req.valid("query");
    const requested: SearchType[] =
      types === undefined ? [...SEARCH_TYPES] : SEARCH_TYPES.filter((type) => types.includes(type));
    const access = searchAccessFor(auth.roles);

    const outcome = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const found = await globalSearch(tx, {
        schoolId: auth.schoolId,
        userId: auth.userId,
        query: q,
        types: requested,
        limit,
        offset,
        access,
      });

      // The query text and which sections it touched are themselves sensitive, so they are
      // recorded -- never a hit's values, only how many there were.
      await emitAuditLog(tx, {
        action: "read",
        targetTable: "global_search",
        targetId: auth.userId,
        newValues: {
          query: q,
          limit,
          offset,
          types: types === undefined ? null : requested,
          sections: found.ran,
          result_counts: Object.fromEntries(
            found.ran.map((type) => [type, found.results[type].length]),
          ),
          totals: Object.fromEntries(found.ran.map((type) => [type, found.totals[type]])),
        },
        clientIp: clientIpFrom(c),
        userAgent: c.req.header("user-agent"),
      });

      return found;
    });

    return c.json(
      { query: q, types: requested, results: outcome.results, totals: outcome.totals },
      200,
    );
  });

  return routes;
}
