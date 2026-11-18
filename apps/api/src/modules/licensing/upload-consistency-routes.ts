import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { withSystemTx } from "../../db/tenant-tx";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";

import { aiProgrammeSchoolParamsSchema } from "./ai-programme-schemas";
import { licenseError } from "./context";
import { readInSchool } from "./service";
import { uploadConsistencyView } from "./upload-consistency";
import {
  uploadConsistencyQuerySchema,
  uploadConsistencySchema,
} from "./upload-consistency-schemas";

import type { LicenseActor } from "./context";
import type { LicensingDeps } from "./service";
import type { SupportedLocale } from "../../middleware/locale";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

/**
 * Upload consistency for the Student AI programme's content bonus (phase 4;
 * docs/billing/ai-upload-consistency.md): read-only, for the dashboards.
 *
 *   * The school's own: `license:read` (ORG_ADMIN and PRINCIPAL), any channel, its own school only --
 *     the school comes from the token, never from the request.
 *   * Any school's, for the super admin: `platform:read`, web channel, like the rest of the console.
 *
 * Both answer the same shape: per class, per teacher and for the school, over `from`..`to` (school
 * calendar days, inclusive) or the current period to date, with the content-bonus tier the
 * percentage falls in on the current licence's values. No money: that is the revenue share's.
 */

// Literal paths in createRoute: the authz matrix's route scan reads them from source.
const SCHOOL_PATH = "/api/school/license/upload-consistency";
const PLATFORM_PATH = "/api/platform/schools/:schoolId/ai-programme/upload-consistency";

const DESCRIPTION =
  "The share of school days (the school's teaching weekdays minus calendar holidays, in its " +
  "timezone, up to today) on which a lesson or material was published for each class that has " +
  "Student AI, per teacher (the mean of their classes) and for the school (the mean of the " +
  "classes). Students' own AI sources never count. `from` and `to` go together; without them, the " +
  "current licence's start (else the academic year's) to today. The bonus tier is shown on the " +
  "current licence's values; no amounts.";

const schoolRoute = createRoute({
  method: "get",
  path: "/api/school/license/upload-consistency",
  operationId: "getSchoolUploadConsistency",
  tags: ["Licensing"],
  security: [{ bearerAuth: [] }],
  summary: "The school's upload consistency for the Student AI content bonus",
  description: DESCRIPTION,
  request: { query: uploadConsistencyQuerySchema },
  responses: standardResponses(
    { 200: { description: "Upload consistency", schema: uploadConsistencySchema } },
    [400, 401, 403],
  ),
});

const platformRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/ai-programme/upload-consistency",
  operationId: "platformGetSchoolUploadConsistency",
  tags: ["Platform"],
  security: [{ bearerAuth: [] }],
  summary: "A school's upload consistency for the Student AI content bonus",
  description: DESCRIPTION,
  request: { params: aiProgrammeSchoolParamsSchema, query: uploadConsistencyQuerySchema },
  responses: standardResponses(
    { 200: { description: "Upload consistency", schema: uploadConsistencySchema } },
    [400, 401, 403, 404],
  ),
});

function actorOf(c: Context<AppEnv>, kind: LicenseActor["kind"]): LicenseActor {
  const auth = requireAuth(c);
  return {
    kind,
    userId: auth.userId,
    homeSchoolId: auth.schoolId,
    requestId: c.get("requestId"),
    locale: (c.get("locale") ?? "en") as SupportedLocale,
  };
}

const requested = (query: { from?: string; to?: string }) =>
  query.from && query.to ? { from: query.from, to: query.to } : null;

export function uploadConsistencyRoutes(deps: LicensingDeps): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(SCHOOL_PATH, requirePermission(PERMISSIONS.LICENSE_READ));
  routes.use(PLATFORM_PATH, requireChannel(AUTH_CHANNELS.WEB));
  routes.use(PLATFORM_PATH, requirePermission(PERMISSIONS.PLATFORM_READ));

  routes.openapi(schoolRoute, async (c) => {
    const actor = actorOf(c, "school");
    const query = c.req.valid("query");
    const view = await readInSchool(deps, actor.homeSchoolId, actor, (tx) =>
      uploadConsistencyView(tx, requested(query)),
    );
    return c.json(view, 200);
  });

  routes.openapi(platformRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const query = c.req.valid("query");
    const actor = actorOf(c, "platform");
    const found = await withSystemTx(
      deps.database,
      (tx) => tx`SELECT 1 FROM app.schools WHERE id = ${schoolId}::uuid`,
    );
    if (found.length === 0) throw licenseError(404, ERROR_CODES.RESOURCE_NOT_FOUND, actor.locale);
    const view = await readInSchool(deps, schoolId, actor, (tx) =>
      uploadConsistencyView(tx, requested(query)),
    );
    return c.json(view, 200);
  });

  return routes;
}
