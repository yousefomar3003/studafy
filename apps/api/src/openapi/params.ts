import { z } from "@hono/zod-openapi";
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from "@studafy/shared-schemas";

/**
 * Request parameter builders for tenant-scoped, index-driven list routes (ST-060).
 *
 * ## Status: staged, not yet consumed
 *
 * No route uses these today. The API has no domain endpoints, and — more to the point — it has no
 * authentication, so there is nothing that could establish which tenant a caller belongs to. A
 * tenant-scoped route built on these helpers right now would take school_id from an unverified path
 * parameter, which is an unauthenticated cross-tenant read, not an access control.
 *
 * They exist now because the constraints they encode are decided now: the pagination cap, the
 * requirement that sorting only ever touch indexed columns, and the descriptions that tell a client
 * which filters are index-backed. Their unit tests are real tests of real behaviour. The first
 * authenticated list route composes them instead of re-deciding them.
 *
 * ## Why the descriptions talk about indexes
 *
 * Every tenant table in this schema carries a school_id-leading B-tree — not by convention but by a
 * CI-enforced catalog rule (SCHOOL_LEADING_INDEX in db/policies/rls-coverage.ts), because the RLS
 * policy `school_id = current_setting('app.school_id')::uuid` is on the read path of every query.
 * Saying so in the spec tells a client which filters are cheap, and tells the next author which
 * access paths the database is actually prepared to serve.
 */

/**
 * The tenant path parameter for routes addressed under a specific school.
 *
 * Named `school_id` rather than a generic `tenant_id` because that is the physical column name on
 * every tenant table, the member of every `(id, school_id)` composite foreign key, and the GUC
 * withTenantTx sets. A second name for it would be a second thing to keep in sync.
 */
export const schoolIdPathParams = z.object({
  school_id: z.uuid().openapi({
    param: { name: "school_id", in: "path" },
    description:
      "School tenant to operate within. Leading column of every tenant index (Index Optimized), " +
      "and the value bound to the app.school_id GUC that the row-level security policy reads.",
    example: "8f14e45f-ceea-4a67-9a2d-1c3e7b0d5a91",
  }),
});

/**
 * The composite tenant lookup: a resource id qualified by its school.
 *
 * This mirrors the physical `UNIQUE (id, school_id)` candidate key that every tenant table carries
 * and that child tables' composite foreign keys reference. It is a candidate key, not the primary
 * key — the PK is `id` alone — but it is the shape a tenant-scoped lookup must use, because reading
 * by `id` alone would be a lookup that RLS has to reject rather than one the index can satisfy.
 */
export const tenantResourcePathParams = schoolIdPathParams.extend({
  id: z.uuid().openapi({
    param: { name: "id", in: "path" },
    description:
      "Resource identifier. Resolved against the composite (id, school_id) candidate key, never " +
      "by id alone.",
  }),
});

/**
 * Cursor pagination query parameters.
 *
 * The bounds come from @studafy/shared-schemas rather than being restated: PAGINATION_MAX_LIMIT is
 * the contract, and a request above it is rejected rather than silently clamped, so a client that
 * asks for 5000 rows learns it was wrong instead of quietly receiving 100 and mis-paginating.
 *
 * The cap is a database concern before it is an API one. An uncapped limit is an unbounded result
 * set materialized in memory and, past the point where the planner abandons the index, a sequential
 * scan of a tenant table.
 */
export const paginationQueryParams = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGINATION_MAX_LIMIT)
    .default(PAGINATION_DEFAULT_LIMIT)
    .openapi({
      param: { name: "limit", in: "query", required: false },
      description:
        `Maximum rows to return. Defaults to ${PAGINATION_DEFAULT_LIMIT}, hard-capped at ` +
        `${PAGINATION_MAX_LIMIT}. A larger value is rejected, not clamped.`,
      example: PAGINATION_DEFAULT_LIMIT,
    }),
  cursor: z
    .string()
    .min(1)
    .optional()
    .openapi({
      param: { name: "cursor", in: "query", required: false },
      description:
        "Opaque forward cursor from a previous response. Its encoding is the server's concern — " +
        "do not construct or parse one. Keyset-based, so pagination depth costs nothing extra.",
    }),
});

/**
 * Build a `sort_by` query parameter restricted to an explicit column allow-list.
 *
 * An enum, never a free string. A free-form sort column is both an injection surface and a
 * performance one: it lets a caller name a column with no B-tree behind it and turn a keyset read
 * into a full sort of a tenant's rows. The allow-list is the set of columns some index can actually
 * order by, so every sort the spec admits is one the planner can serve from an index.
 *
 * @param columns - Indexed columns that may be sorted on. The first is the default.
 */
export function sortByQueryParams<const TColumns extends readonly [string, ...string[]]>(
  columns: TColumns,
) {
  return z.object({
    sort_by: z
      .enum(columns)
      .default(columns[0])
      .openapi({
        param: { name: "sort_by", in: "query", required: false },
        description:
          `Column to sort by. Restricted to index-covered columns (Index Optimized); defaults to ` +
          `${columns[0]}.`,
      }),
    sort_dir: z
      .enum(["asc", "desc"])
      .default("asc")
      .openapi({
        param: { name: "sort_dir", in: "query", required: false },
        description: "Sort direction.",
      }),
  });
}
