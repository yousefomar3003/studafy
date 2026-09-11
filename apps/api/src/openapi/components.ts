import { z } from "@hono/zod-openapi";
import { uuidSchema, dateTimeSchema } from "@studafy/shared-schemas";

import { apiProblemSchema } from "../middleware/errorHandler";

import type { AppEnv } from "../middleware/requestId";
import type { OpenAPIHono } from "@hono/zod-openapi";

/**
 * Reusable OpenAPI component schemas (ST-060).
 *
 * These are **wire projections**, not domain models: snake_case keys matching the physical column
 * names, and only the columns this API is willing to expose. They mirror the migrations exactly —
 * NOT NULL becomes required, a CHECK on char_length becomes maxLength, a uuid column becomes
 * format: uuid — so tests/openapi/db-conformance.test.ts can hold them to the DDL.
 *
 * They live here rather than in @studafy/shared-schemas deliberately. That package's charter
 * (packages/shared-schemas/docs/schema-conventions.md) is "base primitives and cross-cutting
 * envelopes — domain-entity schemas belong in their own packages/services", and it is also consumed
 * by apps/web, where attaching zod-to-openapi metadata would drag an OpenAPI generator into a
 * browser bundle for no benefit. Composing its primitives from here is the intended relationship.
 *
 * No route serves these two specific schemas today — every route with a User- or School-shaped
 * response projects its own narrower, route-specific schema instead. They stay registered as
 * components so the full entity contract is settled and reviewable in one place, checked against the
 * database by tests/openapi/db-conformance.test.ts, independent of which columns any one route
 * currently chooses to expose.
 */

/** Zod's `.openapi()` is added to the prototype by @hono/zod-openapi's import side effect. */

/**
 * app.users.status — mirrors `CREATE TYPE app.user_status` in
 * db/migrations/000007_create_users_and_identity_tables.sql. Order matches the DDL.
 */
export const userStatusSchema = z
  .enum(["invited", "active", "suspended", "archived"])
  .openapi({ description: "Lifecycle state of the user within its school." });

/**
 * app.schools.status — mirrors `CREATE TYPE app.school_status` in
 * db/migrations/000004_create_global_tables.sql. Order matches the DDL.
 */
export const schoolStatusSchema = z
  .enum(["pending", "active", "suspended", "archived"])
  .openapi({ description: "Lifecycle state of the school tenant." });

/**
 * A user, as app.users exposes it.
 *
 * `normalized_email` is deliberately absent: it is a lower(btrim(email)) derivation that exists to
 * back the uq_users_school_normalized_email uniqueness constraint, and it carries no information a
 * client cannot compute from `email`. db-conformance.test.ts records it as the sole permitted
 * omission, so any *other* column added to the table without being considered here fails the build.
 *
 * `id` is the primary key alone; `(id, school_id)` is a UNIQUE candidate key that child tables'
 * composite foreign keys reference. Both are exposed: a client that holds a user needs its tenant to
 * address it under a tenant-scoped route.
 */
export const userSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({
      description: "Owning school tenant. Immutable — enforced by a database trigger, not policy.",
    }),
    email: z.string().max(320).openapi({
      description: "Contact address as supplied. Unique per school after normalization.",
      example: "student@example.edu",
    }),
    display_name: z.string().nullable().openapi({ description: "Optional human-readable name." }),
    status: userStatusSchema,
    email_verified_at: dateTimeSchema
      .nullable()
      .openapi({ description: "Null until the address is verified." }),
    last_login_at: dateTimeSchema.nullable().openapi({ description: "Null until first login." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("User");

/** A school tenant, as app.schools exposes it. Global table — it has no school_id of its own. */
export const schoolSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key. This is the tenant identifier." }),
    slug: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .openapi({ description: "URL-safe unique identifier.", example: "springfield-high" }),
    name: z.string().openapi({ description: "Display name." }),
    status: schoolStatusSchema,
    country_id: uuidSchema,
    default_currency_id: uuidSchema,
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("School");

/**
 * The RFC 9457 envelope every failure in this app produces, as a named component.
 *
 * Tagged, never redeclared: apiProblemSchema is owned by middleware/errorHandler.ts and is what the
 * server actually emits. `.openapi()` clones rather than mutates, so the singleton the error handler
 * uses at runtime is untouched by this call.
 */
export const apiProblemOpenApiSchema = apiProblemSchema.openapi("ProblemDetails");

/**
 * Register components that no route references, and therefore that nothing would otherwise emit.
 *
 * zod-to-openapi only writes a component into the document when an operation reaches it, so User and
 * School — which no endpoint serves yet — need registering by hand or they vanish from the artifact
 * and db-conformance.test.ts has nothing to check.
 *
 * bearerAuth is registered here rather than left to zod-to-openapi's automatic component collection
 * because it must exist before the first route that references it via `security: [{ bearerAuth: [] }]`
 * — same registration-order reasoning as User/School above.
 */
export function registerOpenApiComponents(app: OpenAPIHono<AppEnv>): void {
  app.openAPIRegistry.register("User", userSchema);
  app.openAPIRegistry.register("School", schoolSchema);
  app.openAPIRegistry.register("ProblemDetails", apiProblemOpenApiSchema);

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "RS256 JWT access token, issued by POST /api/auth/login/oauth (or the mobile/mock OAuth " +
      "exchange routes) and verified on every /api/* request by jwtAuthMiddleware — see the " +
      "Authentication guide.",
  });
}
