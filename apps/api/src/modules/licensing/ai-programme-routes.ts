import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { withSystemTx } from "../../db/tenant-tx";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";

import {
  clearSchoolOverride,
  currentAiProgrammeVersion,
  licenseAiProgramme,
  listAiProgrammeOverrides,
  listAiProgrammeVersions,
  previewSchoolOverride,
  reapplyAiProgramme,
  saveAiProgrammeVersion,
  saveSchoolOverride,
  schoolAiProgramme,
} from "./ai-programme";
import {
  aiProgrammeClearBodySchema,
  aiProgrammeCurrentSchema,
  aiProgrammeLicenseParamsSchema,
  aiProgrammeOverrideBodySchema,
  aiProgrammeOverrideListSchema,
  aiProgrammePreviewBodySchema,
  aiProgrammePreviewSchema,
  aiProgrammeReapplyBodySchema,
  aiProgrammeSchoolParamsSchema,
  aiProgrammeVersionBodySchema,
  aiProgrammeVersionListSchema,
  aiProgrammeVersionSchema,
  licenseAiProgrammeSchema,
  schoolAiProgrammeSchema,
} from "./ai-programme-schemas";
import { licenseError } from "./context";
import { readInSchool, readLicense } from "./service";

import type { LicenseActor } from "./context";
import type { LicensingDeps } from "./service";
import type { SupportedLocale } from "../../middleware/locale";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

/**
 * The Student AI programme's settings in the super admin's console (migration 000234): the global
 * versions, a school's override versions and what its values resolve to, and the versions a licence
 * was signed with (re-applying the current ones on request). SUPER_ADMIN only -- platform:read to
 * read, platform:manage to save -- on the web channel, like the rest of the console. Every save is a
 * new version and an audit row, written inside the service transaction.
 *
 * Nothing here is school-facing: later phases (the school's opt-in and dashboards) read the values a
 * licence was signed with through the service (ai-programme.ts), not through these routes.
 */

const TAG = "Platform";

const getCurrentRoute = createRoute({
  method: "get",
  path: "/api/platform/ai-programme",
  operationId: "platformGetAiProgramme",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "The Student AI programme's global settings in force",
  description:
    "The latest global version: prices per currency, minimum seats, the revenue share tiers, " +
    "cap, floor and bonus, the measurement date, grace period, month-to-month rule and payout mode.",
  responses: standardResponses(
    { 200: { description: "The current version", schema: aiProgrammeCurrentSchema } },
    [401, 403],
  ),
});

const listVersionsRoute = createRoute({
  method: "get",
  path: "/api/platform/ai-programme/versions",
  operationId: "platformListAiProgrammeVersions",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Every global Student AI programme version, newest first",
  responses: standardResponses(
    { 200: { description: "Versions", schema: aiProgrammeVersionListSchema } },
    [401, 403],
  ),
});

const saveVersionRoute = createRoute({
  method: "post",
  path: "/api/platform/ai-programme/versions",
  operationId: "platformSaveAiProgrammeVersion",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Save a new global Student AI programme version",
  description:
    "Every setting, with a reason. New quotes, new licences and renewals use it; existing licences " +
    "keep theirs unless the current values are re-applied to them. `basedOnVersionId` is the " +
    "version that was edited: 409 AI_PROGRAMME_VERSION_CONFLICT when a newer one was saved since. " +
    "422 AI_PROGRAMME_VALUE_OUT_OF_RANGE, AI_PROGRAMME_TIERS_INVALID, AI_PROGRAMME_SHARE_ABOVE_MAX, " +
    "AI_PROGRAMME_CURRENCY_INVALID or AI_PROGRAMME_REASON_REQUIRED otherwise. The parent price may " +
    "be any amount, including the licence price or less.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: aiProgrammeVersionBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The new version", schema: aiProgrammeVersionSchema } },
    [400, 401, 403, 409, 422],
  ),
});

const getSchoolRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/ai-programme",
  operationId: "platformGetSchoolAiProgramme",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "A school's Student AI programme settings",
  description:
    "The global version in force, the school's override version (null when it never had one), and " +
    "the effective values in the school's currency: the school's value wherever it sets one.",
  request: { params: aiProgrammeSchoolParamsSchema },
  responses: standardResponses(
    { 200: { description: "The school's settings", schema: schoolAiProgrammeSchema } },
    [401, 403, 404],
  ),
});

const listOverridesRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/ai-programme/overrides",
  operationId: "platformListSchoolAiProgrammeOverrides",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "A school's Student AI programme override versions, newest first",
  request: { params: aiProgrammeSchoolParamsSchema },
  responses: standardResponses(
    { 200: { description: "Override versions", schema: aiProgrammeOverrideListSchema } },
    [401, 403, 404],
  ),
});

const saveOverrideRoute = createRoute({
  method: "put",
  path: "/api/platform/schools/{schoolId}/ai-programme/override",
  operationId: "platformSaveSchoolAiProgrammeOverride",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Save a new override version for a school",
  description:
    "Any subset of the settings (null inherits the global value), with a reason. Prices are in the " +
    "school's currency. Existing licences keep their values. `basedOnOverrideId` is the override " +
    "version that was edited (null: none): 409 AI_PROGRAMME_VERSION_CONFLICT when stale.",
  request: {
    params: aiProgrammeSchoolParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: aiProgrammeOverrideBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The school's settings", schema: schoolAiProgrammeSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const clearOverrideRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/ai-programme/override/clear",
  operationId: "platformClearSchoolAiProgrammeOverride",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Clear a school's overrides",
  description:
    "Saves a new, empty override version (with a reason): the school inherits every global value " +
    "again. Nothing is written when the school has no overrides.",
  request: {
    params: aiProgrammeSchoolParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: aiProgrammeClearBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The school's settings", schema: schoolAiProgrammeSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const previewRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/ai-programme/preview",
  operationId: "platformPreviewSchoolAiProgramme",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Preview a school's effective values with a draft override",
  description:
    "Saves nothing. The values the school would have with this override, and what would stop it " +
    "being saved (an empty list when it can be).",
  request: {
    params: aiProgrammeSchoolParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: aiProgrammePreviewBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The preview", schema: aiProgrammePreviewSchema } },
    [400, 401, 403, 404],
  ),
});

const getLicenseRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/licenses/{licenseId}/ai-programme",
  operationId: "platformGetLicenseAiProgramme",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "The Student AI programme values a licence was signed with",
  description:
    "The versions on the licence and what they resolve to in its currency, next to the values in " +
    "force now and the fields that would change if they were re-applied.",
  request: { params: aiProgrammeLicenseParamsSchema },
  responses: standardResponses(
    { 200: { description: "The licence's values", schema: licenseAiProgrammeSchema } },
    [401, 403, 404],
  ),
});

const reapplyRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/licenses/{licenseId}/ai-programme/reapply",
  operationId: "platformReapplyLicenseAiProgramme",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Apply the current Student AI programme values to a licence",
  description:
    "Moves the licence onto the versions in force now (its grace period with them), with a reason, " +
    "audited. Refused (409 LICENSE_NOT_EDITABLE) for an expired or cancelled licence.",
  request: {
    params: aiProgrammeLicenseParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: aiProgrammeReapplyBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The licence's values", schema: licenseAiProgrammeSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

function platformActor(c: Context<AppEnv>): LicenseActor {
  const auth = requireAuth(c);
  return {
    kind: "platform",
    userId: auth.userId,
    homeSchoolId: auth.schoolId,
    requestId: c.get("requestId"),
    locale: (c.get("locale") ?? "en") as SupportedLocale,
  };
}

export function platformAiProgrammeRoutes(deps: LicensingDeps): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const manage = requirePermission(PERMISSIONS.PLATFORM_MANAGE);
  const writesOnly = (c: Context<AppEnv>, next: () => Promise<void>) =>
    c.req.method === "GET" ? next() : manage(c, next);

  const paths = [
    "/api/platform/ai-programme",
    "/api/platform/ai-programme/*",
    "/api/platform/schools/:schoolId/ai-programme",
    "/api/platform/schools/:schoolId/ai-programme/*",
    "/api/platform/schools/:schoolId/licenses/:licenseId/ai-programme",
    "/api/platform/schools/:schoolId/licenses/:licenseId/ai-programme/*",
  ];
  for (const path of paths) routes.use(path, requireChannel(AUTH_CHANNELS.WEB));
  for (const path of paths) routes.use(path, requirePermission(PERMISSIONS.PLATFORM_READ));
  for (const path of paths) routes.use(path, writesOnly);

  routes.use("/api/platform/ai-programme/versions", auditAction("insert", "ai_programme_versions"));
  routes.use(
    "/api/platform/schools/:schoolId/ai-programme/override",
    auditAction("insert", "ai_programme_school_overrides"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/ai-programme/override/clear",
    auditAction("insert", "ai_programme_school_overrides"),
  );
  // The preview writes nothing; declared for the audit coverage gate, like the calculator.
  routes.use(
    "/api/platform/schools/:schoolId/ai-programme/preview",
    auditAction("insert", "ai_programme_school_overrides"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/licenses/:licenseId/ai-programme/reapply",
    auditAction("update", "school_licenses"),
  );

  /** A school that exists, or 404, before arming its scope. */
  async function requireSchool(schoolId: string, actor: LicenseActor): Promise<void> {
    const found = await withSystemTx(
      deps.database,
      (tx) => tx`SELECT 1 FROM app.schools WHERE id = ${schoolId}::uuid`,
    );
    if (found.length === 0) throw licenseError(404, ERROR_CODES.RESOURCE_NOT_FOUND, actor.locale);
  }

  routes.openapi(getCurrentRoute, async (c) => {
    const current = await withSystemTx(deps.database, currentAiProgrammeVersion);
    return c.json({ current }, 200);
  });

  routes.openapi(listVersionsRoute, async (c) => {
    const versions = await withSystemTx(deps.database, listAiProgrammeVersions);
    return c.json({ versions }, 200);
  });

  routes.openapi(saveVersionRoute, async (c) => {
    const body = c.req.valid("json");
    const actor = platformActor(c);
    const version = await withSystemTx(deps.database, (tx) =>
      saveAiProgrammeVersion(tx, body, actor),
    );
    return c.json(version, 201);
  });

  routes.openapi(getSchoolRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const actor = platformActor(c);
    await requireSchool(schoolId, actor);
    const view = await readInSchool(deps, schoolId, actor, schoolAiProgramme);
    return c.json(view, 200);
  });

  routes.openapi(listOverridesRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const actor = platformActor(c);
    await requireSchool(schoolId, actor);
    const overrides = await readInSchool(deps, schoolId, actor, listAiProgrammeOverrides);
    return c.json({ overrides }, 200);
  });

  routes.openapi(saveOverrideRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    await requireSchool(schoolId, actor);
    const view = await readInSchool(deps, schoolId, actor, async (tx) => {
      await saveSchoolOverride(tx, schoolId, body, actor);
      return schoolAiProgramme(tx);
    });
    return c.json(view, 200);
  });

  routes.openapi(clearOverrideRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    await requireSchool(schoolId, actor);
    const view = await readInSchool(deps, schoolId, actor, async (tx) => {
      await clearSchoolOverride(tx, schoolId, body, actor);
      return schoolAiProgramme(tx);
    });
    return c.json(view, 200);
  });

  routes.openapi(previewRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    await requireSchool(schoolId, actor);
    const preview = await readInSchool(deps, schoolId, actor, (tx) =>
      previewSchoolOverride(tx, body),
    );
    return c.json(preview, 200);
  });

  routes.openapi(getLicenseRoute, async (c) => {
    const { schoolId, licenseId } = c.req.valid("param");
    const actor = platformActor(c);
    const view = await readInSchool(deps, schoolId, actor, async (tx) => {
      const license = await readLicense(tx, licenseId);
      if (!license) throw licenseError(404, ERROR_CODES.LICENSE_NOT_FOUND, actor.locale);
      return licenseAiProgramme(tx, license);
    });
    return c.json(view, 200);
  });

  routes.openapi(reapplyRoute, async (c) => {
    const { schoolId, licenseId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const actor = platformActor(c);
    const view = await readInSchool(deps, schoolId, actor, async (tx) => {
      const license = await readLicense(tx, licenseId, { forUpdate: true });
      if (!license) throw licenseError(404, ERROR_CODES.LICENSE_NOT_FOUND, actor.locale);
      return reapplyAiProgramme(tx, schoolId, license, reason, actor);
    });
    return c.json(view, 200);
  });

  return routes;
}
