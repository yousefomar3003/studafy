import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission, requirePermissionIn } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  documentLanguageSettingsSchema,
  updateDocumentLanguageSettingsBodySchema,
} from "../document-language-schemas";
import {
  getDocumentLanguageSettings,
  updateDocumentLanguageSettings,
} from "../document-language-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";

const TAGS = ["Results"];
const security = [{ bearerAuth: [] }];

const getRoute = createRoute({
  method: "get",
  path: "/api/grading/document-language-settings",
  tags: TAGS,
  operationId: "getDocumentLanguageSettings",
  summary: "The language report cards, certificates and transcripts are issued in",
  description:
    "Per document type: viewer (each reader's language, the default), en, ar or bilingual; and the school's Arabic name shown on documents.",
  security,
  responses: standardResponses(
    { 200: { description: "Settings.", schema: documentLanguageSettingsSchema } },
    [401, 403, 500],
  ),
});

const updateRoute = createRoute({
  method: "put",
  path: "/api/grading/document-language-settings",
  tags: TAGS,
  operationId: "updateDocumentLanguageSettings",
  summary: "Change the language documents are issued in",
  description:
    "Omitted fields keep their value. Only documents issued afterwards are affected: an issued document keeps the language and names it was issued with.",
  security,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: updateDocumentLanguageSettingsBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "Saved settings.", schema: documentLanguageSettingsSchema } },
    [400, 401, 403, 500],
  ),
});

export function gradingDocumentLanguageRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(
    "/api/grading/document-language-settings",
    requirePermission(PERMISSIONS.ACADEMIC_CONFIG_READ),
  );
  routes.use("/api/grading/document-language-settings", async (c, next) => {
    if (c.req.method === "PUT") requirePermissionIn(c, PERMISSIONS.ACADEMIC_CONFIG_MANAGE);
    await next();
  });
  routes.use(
    "/api/grading/document-language-settings",
    auditAction("update", "document_language_settings"),
  );

  routes.openapi(getRoute, async (c) => {
    const auth = requireAuth(c);
    const tenant = { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
    return c.json(
      await withTenantTx(database, tenant, (tx) => getDocumentLanguageSettings(tx, auth.schoolId)),
      200,
    );
  });

  routes.openapi(updateRoute, async (c) => {
    const body = c.req.valid("json");
    const auth = requireAuth(c);
    const tenant = { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateDocumentLanguageSettings(tx, auth.schoolId, body),
      ),
      200,
    );
  });

  return routes;
}
