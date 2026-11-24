import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../db/tenant-tx";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { openApiValidationHook } from "../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";

import { contentTypeFor, exportFileName, renderCsv, renderXlsx } from "./file";
import {
  XLSX_MEDIA_TYPE,
  ministryExportExampleListSchema,
  ministryExportPreviewSchema,
  ministryExportRunBodySchema,
  ministryExportTemplateBodySchema,
  ministryExportTemplateIdParamSchema,
  ministryExportTemplateListSchema,
  ministryExportTemplateSchema,
} from "./schemas";
import {
  createMinistryExportTemplate,
  deleteMinistryExportTemplate,
  listMinistryExportExamples,
  listMinistryExportTemplates,
  previewMinistryExport,
  runMinistryExport,
  updateMinistryExportTemplate,
} from "./service";

import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { RecordKeyring } from "@studafy/records";
import type { Context } from "hono";

/**
 * Ministry results export (000264). School leadership, from the web app only: templates behind
 * academicConfig:manage, previews and downloads behind result:finalize. Reading the national ID
 * also needs studentRecord:read, and opening a sensitive one studentRecord:readSensitive (checked
 * in the service, which knows the template's field).
 */

const TAGS = ["Ministry export"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const listExamplesRoute = createRoute({
  method: "get",
  path: "/api/grading/ministry-export-examples",
  tags: TAGS,
  operationId: "listMinistryExportExamples",
  summary: "Built-in starting templates",
  description:
    "Editable examples to start a template from. None of them is an official ministry format.",
  security,
  responses: standardResponses(
    { 200: { description: "Examples.", schema: ministryExportExampleListSchema } },
    [401, 403, 500],
  ),
});

const listTemplatesRoute = createRoute({
  method: "get",
  path: "/api/grading/ministry-export-templates",
  tags: TAGS,
  operationId: "listMinistryExportTemplates",
  summary: "The school's ministry export templates",
  security,
  responses: standardResponses(
    { 200: { description: "Templates by name.", schema: ministryExportTemplateListSchema } },
    [401, 403, 500],
  ),
});

const createTemplateRoute = createRoute({
  method: "post",
  path: "/api/grading/ministry-export-templates",
  tags: TAGS,
  operationId: "createMinistryExportTemplate",
  summary: "Add a ministry export template",
  description:
    "400 when the columns break a rule (subject fields on overall rows, a fixed-text column " +
    "without its text...), 404 when the national ID field or a subject is not the school's, 409 " +
    "when the name is taken.",
  security,
  request: { body: json(ministryExportTemplateBodySchema) },
  responses: standardResponses(
    { 201: { description: "The new template.", schema: ministryExportTemplateSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const updateTemplateRoute = createRoute({
  method: "put",
  path: "/api/grading/ministry-export-templates/{templateId}",
  tags: TAGS,
  operationId: "updateMinistryExportTemplate",
  summary: "Replace a ministry export template",
  description: "Its columns, value maps and subject codes are replaced with the request's.",
  security,
  request: {
    params: ministryExportTemplateIdParamSchema,
    body: json(ministryExportTemplateBodySchema),
  },
  responses: standardResponses(
    { 200: { description: "The template.", schema: ministryExportTemplateSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteTemplateRoute = createRoute({
  method: "delete",
  path: "/api/grading/ministry-export-templates/{templateId}",
  tags: TAGS,
  operationId: "deleteMinistryExportTemplate",
  summary: "Delete a ministry export template",
  security,
  request: { params: ministryExportTemplateIdParamSchema },
  responses: {
    204: { description: "Deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

const previewRoute = createRoute({
  method: "post",
  path: "/api/grading/ministry-exports/preview",
  tags: TAGS,
  operationId: "previewMinistryExport",
  summary: "Preview a ministry export",
  description:
    "The file's heading and first rows, how many rows and students it has, and what to fix " +
    "first: students without a national ID, subjects without a ministry code, sections not " +
    "finalized for the period. Finalized results only. A sensitive national ID shows as its mask.",
  security,
  request: { body: json(ministryExportRunBodySchema) },
  responses: standardResponses(
    { 200: { description: "The preview.", schema: ministryExportPreviewSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const downloadRoute = createRoute({
  method: "post",
  path: "/api/grading/ministry-exports/download",
  tags: TAGS,
  operationId: "downloadMinistryExport",
  summary: "Download a ministry export",
  description:
    "The whole file, CSV or XLSX as the template says, from finalized results only. A sensitive " +
    "national ID is opened only for a caller holding studentRecord:readSensitive (403 otherwise; " +
    "503 RECORD_KEY_UNAVAILABLE when a value cannot be opened). Audited, with a reveal entry " +
    "naming the students whose sensitive national IDs were opened.",
  security,
  request: { body: json(ministryExportRunBodySchema) },
  responses: {
    200: {
      description: "The export file.",
      headers: requestIdHeaders,
      content: {
        "text/csv": { schema: { type: "string" } },
        [XLSX_MEDIA_TYPE]: { schema: { type: "string", format: "binary" } },
      },
    },
    ...standardResponses({}, [400, 401, 403, 404, 500, 503]),
  },
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return {
    schoolId: auth.schoolId,
    userId: auth.userId,
    roles: auth.roles,
    requestId: c.get("requestId"),
  };
}

export function ministryExportRoutes(
  database: Database,
  keyring: RecordKeyring,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // A leadership feature of the web app, and a download can open sensitive national IDs: like the
  // records reveal, browser sessions only.
  const web = requireChannel(AUTH_CHANNELS.WEB);
  const manage = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_MANAGE);
  const run = requirePermission(PERMISSIONS.RESULT_FINALIZE);

  routes.use("/api/grading/ministry-export-examples", web, manage);
  routes.use(
    "/api/grading/ministry-export-templates",
    web,
    manage,
    auditAction("insert", "ministry_export_templates"),
  );
  routes.on(
    "PUT",
    "/api/grading/ministry-export-templates/:templateId",
    web,
    manage,
    auditAction("update", "ministry_export_templates"),
  );
  routes.on(
    "DELETE",
    "/api/grading/ministry-export-templates/:templateId",
    web,
    manage,
    auditAction("delete", "ministry_export_templates"),
  );
  // The preview writes nothing; it declares what its download audits.
  routes.use(
    "/api/grading/ministry-exports/preview",
    web,
    run,
    auditAction("export", "ministry_export_templates"),
  );
  routes.use(
    "/api/grading/ministry-exports/download",
    web,
    run,
    auditAction("export", "ministry_export_templates"),
  );

  routes.openapi(listExamplesRoute, (c) => c.json({ examples: listMinistryExportExamples() }, 200));

  routes.openapi(listTemplatesRoute, async (c) => {
    const tenant = tenantFrom(c);
    const templates = await withTenantTx(database, tenant, (tx) =>
      listMinistryExportTemplates(tx, tenant.schoolId),
    );
    return c.json({ templates }, 200);
  });

  routes.openapi(createTemplateRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        createMinistryExportTemplate(tx, tenant.schoolId, body),
      ),
      201,
    );
  });

  routes.openapi(updateTemplateRoute, async (c) => {
    const { templateId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateMinistryExportTemplate(tx, tenant.schoolId, templateId, body),
      ),
      200,
    );
  });

  routes.openapi(deleteTemplateRoute, async (c) => {
    const { templateId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) =>
      deleteMinistryExportTemplate(tx, tenant.schoolId, templateId),
    );
    return c.body(null, 204);
  });

  routes.openapi(previewRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    const preview = await withTenantTx(database, tenant, (tx) =>
      previewMinistryExport(tx, tenant, body),
    );
    c.header("Cache-Control", "no-store");
    return c.json(preview, 200);
  });

  routes.openapi(downloadRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    // Rendered inside the transaction, so a file that fails to render leaves no audit row behind.
    const { format, content, fileName } = await withTenantTx(database, tenant, async (tx) => {
      const file = await runMinistryExport(tx, tenant, body, keyring);
      const fileFormat = file.template.file_format;
      return {
        format: fileFormat,
        content:
          fileFormat === "xlsx"
            ? await renderXlsx(file, new Date())
            : renderCsv(file, file.template.encoding),
        fileName: exportFileName(
          file.template.name,
          [file.period.yearCode, file.period.termName ?? "annual"],
          fileFormat,
        ),
      };
    });
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": contentTypeFor(format),
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  });

  return routes;
}
