import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../db/tenant-tx";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { hasPermission } from "../../middleware/authz";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import { globalSearchResultSchema, searchQuerySchema } from "./schemas";
import { globalSearch } from "./service";

import type { GlobalSearchSections } from "./service";
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
 * Which sections a caller may see, reusing the exact permission each type's own endpoint already
 * requires (GET /api/students -> STUDENT_READ, GET /api/users -> USER_READ, GET
 * /api/finance/invoices -> BILLING_READ, materials -> MATERIAL_READ). This is the whole of
 * "results respect role scope" at the section level: a FINANCE caller (BILLING_READ, USER_READ,
 * neither STUDENT_READ nor MATERIAL_READ per packages/constants/src/permissions.ts) gets invoices
 * and users back and an empty array for students/materials; an INSTRUCTOR gets the reverse. Which
 * *rows* come back within a permitted section is a separate, database-enforced question -- see the
 * module header in ./service.ts.
 */
function sectionsFor(roles: readonly Role[]): GlobalSearchSections {
  return {
    students: hasPermission(roles, PERMISSIONS.STUDENT_READ),
    users: hasPermission(roles, PERMISSIONS.USER_READ),
    invoices: hasPermission(roles, PERMISSIONS.BILLING_READ),
    materials: hasPermission(roles, PERMISSIONS.MATERIAL_READ),
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
  summary: "Search across students, users, invoices, and materials",
  description:
    "Role-scoped full-text search (Postgres websearch_to_tsquery) across the four record types " +
    "a school's staff commonly look someone or something up by, grouped per type. A caller only " +
    "ever sees a type's section populated when they hold that type's own read permission " +
    "(STUDENT_READ, USER_READ, BILLING_READ, MATERIAL_READ) -- for example FINANCE finds " +
    "invoices but never students, and INSTRUCTOR the reverse. Within a permitted section, row-level " +
    "security applies exactly as it does on that type's own list endpoint (a teacher's student " +
    "results are limited to students in classes they teach, for instance). Every call is recorded " +
    "as a 'read' audit entry against 'global_search', since the query text and which sections it " +
    "touched are themselves sensitive.",
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
    const { q, limit } = c.req.valid("query");
    const sections = sectionsFor(auth.roles);

    const results = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const hits = await globalSearch(tx, auth.schoolId, q, limit, sections);

      await emitAuditLog(tx, {
        action: "read",
        targetTable: "global_search",
        targetId: auth.userId,
        newValues: {
          query: q,
          limit,
          sections: Object.entries(sections)
            .filter(([, enabled]) => enabled)
            .map(([name]) => name),
          result_counts: {
            students: hits.students.length,
            users: hits.users.length,
            invoices: hits.invoices.length,
            materials: hits.materials.length,
          },
        },
        clientIp: clientIpFrom(c),
        userAgent: c.req.header("user-agent"),
      });

      return hits;
    });

    return c.json({ query: q, results }, 200);
  });

  return routes;
}
