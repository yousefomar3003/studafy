import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { getLocalizedMessage } from "../../../middleware/locale";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AI_DATA_CATEGORIES, AI_DATA_SHARING_DISCLOSURE } from "../consent/disclosure";
import { findCurrentConsent, grantConsent, withdrawConsent } from "../consent/persistence";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { AiDataSharingConsent } from "../consent/persistence";
import type { Context } from "hono";

/**
 * Third-party AI data-sharing consent (ST-305): `GET|PUT|DELETE /api/ai/consent`.
 *
 * GET serves the disclosure the consent modal renders (provider and data categories) together with
 * the caller's consent to it, if any. PUT records consent to the disclosure version the client
 * showed; DELETE withdraws it. Both are self-service on the caller's own record, idempotent, and
 * audited (consent/persistence.ts). None of these calls reach the model provider or draw on quota,
 * and withdrawal must always be possible, so the entitlement and consent gates both pass them
 * through.
 */

const disclosureSchema = z.object({
  version: z.string(),
  provider: z.object({
    id: z.string(),
    name: z.string(),
    privacyPolicyUrl: z.string().url(),
  }),
  dataCategories: z.array(z.enum(AI_DATA_CATEGORIES)),
});

const consentSchema = z.object({
  id: z.string().uuid(),
  disclosureVersion: z.string(),
  provider: z.string(),
  dataCategories: z.array(z.string()),
  grantedAt: z.string().datetime(),
});

const consentStatusSchema = z.object({
  disclosure: disclosureSchema,
  /** The caller's consent to the current disclosure; null means AI features are refused. */
  consent: consentSchema.nullable(),
});

const grantBodySchema = z.object({
  disclosureVersion: z.string().min(1).openapi({
    description: "The disclosure version the user was shown and agreed to.",
    example: AI_DATA_SHARING_DISCLOSURE.version,
  }),
});

const getConsentRoute = createRoute({
  method: "get",
  path: "/api/ai/consent",
  tags: ["AI"],
  operationId: "getAiConsent",
  summary: "Get the AI data-sharing disclosure and the caller's consent",
  description:
    "Returns the third-party AI data-sharing disclosure (the model provider and the categories of " +
    "data sent to it) and the caller's consent to the current disclosure version, or null. AI " +
    "routes that call the model refuse with 403 AI_CONSENT_REQUIRED while `consent` is null.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Disclosure and consent status", schema: consentStatusSchema } },
    [401],
  ),
});

const grantConsentRoute = createRoute({
  method: "put",
  path: "/api/ai/consent",
  tags: ["AI"],
  operationId: "grantAiConsent",
  summary: "Consent to sharing AI inputs with the model provider",
  description:
    "Records the caller's consent to the disclosure version they were shown. Idempotent. Refuses " +
    "with 409 AI_CONSENT_DISCLOSURE_OUTDATED when that version is not the one currently served.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: grantBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "Consent recorded", schema: consentStatusSchema } },
    [400, 401, 409],
  ),
});

const withdrawConsentRoute = createRoute({
  method: "delete",
  path: "/api/ai/consent",
  tags: ["AI"],
  operationId: "withdrawAiConsent",
  summary: "Withdraw consent to sharing AI inputs with the model provider",
  description:
    "Withdraws the caller's consent. Idempotent. From the next request on, AI routes that call the " +
    "model refuse with 403 AI_CONSENT_REQUIRED until consent is granted again.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Consent withdrawn", schema: consentStatusSchema } },
    [401],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function status(consent: AiDataSharingConsent | null) {
  const { dataCategories, ...disclosure } = AI_DATA_SHARING_DISCLOSURE;
  return { disclosure: { ...disclosure, dataCategories: [...dataCategories] }, consent };
}

export function aiConsentRoutes(deps: { database: Database }): OpenAPIHono<AppEnv> {
  const { database } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Grant inserts a consent row; withdrawal stamps withdrawn_at on it. Both write their own
  // app.audit_logs rows inside the transaction (consent/persistence.ts).
  routes.on("PUT", "/api/ai/consent", auditAction("insert", "ai_data_sharing_consents"));
  routes.on("DELETE", "/api/ai/consent", auditAction("update", "ai_data_sharing_consents"));

  routes.openapi(getConsentRoute, async (c) => {
    const { userId } = requireAuth(c);
    const consent = await withTenantTx(database, tenantFrom(c), (tx) =>
      findCurrentConsent(tx, userId),
    );
    return c.json(status(consent), 200);
  });

  routes.openapi(grantConsentRoute, async (c) => {
    const { schoolId, userId } = requireAuth(c);
    const { disclosureVersion } = c.req.valid("json");

    if (disclosureVersion !== AI_DATA_SHARING_DISCLOSURE.version) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.AI_CONSENT_DISCLOSURE_OUTDATED,
        getLocalizedMessage(
          ERROR_CODES.AI_CONSENT_DISCLOSURE_OUTDATED,
          (c.get("locale") ?? "en") as SupportedLocale,
        ),
      );
    }

    const consent = await withTenantTx(database, tenantFrom(c), (tx) =>
      grantConsent(tx, schoolId, userId, c.req.header("user-agent") ?? null),
    );
    return c.json(status(consent), 200);
  });

  routes.openapi(withdrawConsentRoute, async (c) => {
    const { userId } = requireAuth(c);
    await withTenantTx(database, tenantFrom(c), (tx) => withdrawConsent(tx, userId));
    return c.json(status(null), 200);
  });

  return routes;
}
