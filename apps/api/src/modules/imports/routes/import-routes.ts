import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { QUEUE_NAMES, PERMISSIONS } from "@studafy/constants";
import { Queue } from "bullmq";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import {
  confirmImport,
  createMapping,
  deleteMapping,
  getImport,
  getImportDiff,
  listImports,
  listMappings,
  updateImportMapping,
  updateMapping,
  uploadImport,
} from "../import-service";
import {
  confirmImportBodySchema,
  createStudentImportMappingBodySchema,
  importDiffQuerySchema,
  importDiffSchema,
  importIdParamSchema,
  importListQuerySchema,
  importListSchema,
  importRecordSchema,
  mappingIdParamSchema,
  studentImportMappingListSchema,
  studentImportMappingSchema,
  updateImportMappingBodySchema,
  updateStudentImportMappingBodySchema,
  uploadImportQuerySchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { ImportRecord, StudentImportMapping } from "../import-service";
import type { ImportRecordResponse, StudentImportMappingResponse } from "../schemas";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function toResponse(record: ImportRecord): ImportRecordResponse {
  return {
    id: record.id,
    school_id: record.school_id,
    uploaded_by: record.uploaded_by,
    confirmed_by: record.confirmed_by,
    status: record.status,
    file_name: record.file_name,
    row_count: record.row_count,
    valid_rows: record.valid_rows,
    error_rows: record.error_rows,
    header_line: record.header_line,
    source_headers: record.source_headers,
    column_mapping: record.column_mapping,
    errors: record.errors,
    summary: record.summary,
    created_at: record.created_at.toISOString(),
    updated_at: record.updated_at.toISOString(),
    confirmed_at: record.confirmed_at?.toISOString() ?? null,
    completed_at: record.completed_at?.toISOString() ?? null,
  };
}

function toMappingResponse(mapping: StudentImportMapping): StudentImportMappingResponse {
  return {
    id: mapping.id,
    name: mapping.name,
    column_mapping: mapping.column_mapping,
    created_by: mapping.created_by,
    created_at: mapping.created_at.toISOString(),
    updated_at: mapping.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const uploadStudentCsvRoute = createRoute({
  method: "post",
  path: "/api/imports/students/upload",
  tags: ["Imports"],
  operationId: "uploadStudentCsv",
  summary: "Upload student CSV for validation",
  description:
    "Uploads a CSV file of students, in the template layout or any other. The header row is " +
    "detected (title lines above it are skipped) and mapped with the saved mapping named by " +
    "mapping_id, or with one suggested from the headers. Every data line is staged and validated; " +
    "the report carries line-level errors. Max 10,000 rows.",
  security: [{ bearerAuth: [] }],
  request: {
    query: uploadImportQuerySchema,
    body: {
      required: true,
      content: { "text/csv": { schema: { type: "string" } } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "Import record with validation results.",
        schema: importRecordSchema,
      },
    },
    [400, 401, 403, 404, 429, 500],
  ),
});

const confirmStudentImportRoute = createRoute({
  method: "post",
  path: "/api/imports/students/{importId}/confirm",
  tags: ["Imports"],
  operationId: "confirmStudentImport",
  summary: "Confirm a validated import",
  description:
    "Confirms a previously uploaded import, transitioning it to confirmed state. A BullMQ job " +
    "will process the rows asynchronously. Providing an idempotency_key makes the endpoint safe " +
    "to retry: re-running with the same key returns the existing import.",
  security: [{ bearerAuth: [] }],
  request: {
    params: importIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: confirmImportBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Import confirmed and queued for processing.",
        schema: importRecordSchema,
      },
    },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

const getStudentImportRoute = createRoute({
  method: "get",
  path: "/api/imports/students/{importId}",
  tags: ["Imports"],
  operationId: "getStudentImport",
  summary: "Get import status and results",
  description: "Returns the import record including validation errors and processing summary.",
  security: [{ bearerAuth: [] }],
  request: { params: importIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The import record.",
        schema: importRecordSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const listStudentImportsRoute = createRoute({
  method: "get",
  path: "/api/imports/students",
  tags: ["Imports"],
  operationId: "listStudentImports",
  summary: "List imports",
  description: "Paginated, cursor-based list of student imports for the authenticated school.",
  security: [{ bearerAuth: [] }],
  request: { query: importListQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of imports.",
        schema: importListSchema,
      },
    },
    [401, 403, 429, 500],
  ),
});

const downloadTemplateRoute = createRoute({
  method: "get",
  path: "/api/imports/students/template",
  tags: ["Imports"],
  operationId: "downloadStudentImportTemplate",
  summary: "Download student import CSV template",
  description: "Returns a CSV file with the expected headers and an example row.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "CSV template file.",
      headers: {
        "X-Request-Id": {
          required: true,
          schema: { format: "uuid" },
          description: "Server-generated correlation id.",
        },
        "Content-Disposition": { schema: { type: "string" } },
      },
      content: { "text/csv": { schema: { type: "string" } } },
    },
    401: {
      description: "Authentication is missing or invalid.",
      headers: {
        "X-Request-Id": {
          required: true,
          schema: { format: "uuid" },
          description: "Server-generated correlation id.",
        },
      },
      content: {
        "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } },
      },
    },
    403: {
      description: "Authenticated, but not permitted to perform this operation.",
      headers: {
        "X-Request-Id": {
          required: true,
          schema: { format: "uuid" },
          description: "Server-generated correlation id.",
        },
      },
      content: {
        "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } },
      },
    },
    429: {
      description: "Rate limit exceeded. Back off and retry.",
      headers: {
        "X-Request-Id": {
          required: true,
          schema: { format: "uuid" },
          description: "Server-generated correlation id.",
        },
      },
      content: {
        "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } },
      },
    },
    500: {
      description: "Unexpected server error.",
      headers: {
        "X-Request-Id": {
          required: true,
          schema: { format: "uuid" },
          description: "Server-generated correlation id.",
        },
      },
      content: {
        "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } },
      },
    },
  },
});

const updateStudentImportMappingRoute = createRoute({
  method: "put",
  path: "/api/imports/students/{importId}/mapping",
  tags: ["Imports"],
  operationId: "updateStudentImportMapping",
  summary: "Re-map an unconfirmed import",
  description:
    "Applies a new column mapping to the import's staged rows and re-validates them, without a " +
    "re-upload. With save_as, the mapping is also saved for the school. Only an uploaded or " +
    "validated import can be re-mapped.",
  security: [{ bearerAuth: [] }],
  request: {
    params: importIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateImportMappingBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: { description: "Import re-validated with the new mapping.", schema: importRecordSchema },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const getStudentImportDiffRoute = createRoute({
  method: "get",
  path: "/api/imports/students/{importId}/diff",
  tags: ["Imports"],
  operationId: "getStudentImportDiff",
  summary: "Dry-run diff against live data",
  description:
    "Classifies every valid staged row as create, update, unchanged or conflict against the " +
    "school's live students, parents and links, with the field changes each update makes. " +
    "Read-only. The migration recomputes this plan when it runs, so it reflects live data then.",
  security: [{ bearerAuth: [] }],
  request: { params: importIdParamSchema, query: importDiffQuerySchema },
  responses: standardResponses(
    { 200: { description: "The dry-run diff.", schema: importDiffSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const listStudentImportMappingsRoute = createRoute({
  method: "get",
  path: "/api/imports/students/mappings",
  tags: ["Imports"],
  operationId: "listStudentImportMappings",
  summary: "List saved column mappings",
  description: "The school's saved CSV column mappings, by name.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Saved mappings.", schema: studentImportMappingListSchema } },
    [401, 403, 500],
  ),
});

const createStudentImportMappingRoute = createRoute({
  method: "post",
  path: "/api/imports/students/mappings",
  tags: ["Imports"],
  operationId: "createStudentImportMapping",
  summary: "Save a column mapping",
  description:
    "Saves a column mapping for reuse on later uploads. It must map every required field. " +
    "Names are unique per school, case-insensitively.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createStudentImportMappingBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The saved mapping.", schema: studentImportMappingSchema } },
    [400, 401, 403, 409, 500],
  ),
});

const updateSavedStudentImportMappingRoute = createRoute({
  method: "patch",
  path: "/api/imports/students/mappings/{mappingId}",
  tags: ["Imports"],
  operationId: "updateSavedStudentImportMapping",
  summary: "Rename or change a saved column mapping",
  description:
    "Changes a saved mapping. Imports already staged with it keep the mapping they were staged with.",
  security: [{ bearerAuth: [] }],
  request: {
    params: mappingIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateStudentImportMappingBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated mapping.", schema: studentImportMappingSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteStudentImportMappingRoute = createRoute({
  method: "delete",
  path: "/api/imports/students/mappings/{mappingId}",
  tags: ["Imports"],
  operationId: "deleteStudentImportMapping",
  summary: "Delete a saved column mapping",
  description: "Deletes a saved mapping. Imports already staged with it are unaffected.",
  security: [{ bearerAuth: [] }],
  request: { params: mappingIdParamSchema },
  responses: {
    204: { description: "Mapping deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

const CSV_TEMPLATE =
  "admission_number,email,first_name,middle_name,last_name,preferred_name,date_of_birth,status,parent_email,parent_relationship\n" +
  "ADM-2024-001,jane.doe@example.edu,Jane,Marie,Doe,Jenny,2010-03-15,enrolled,parent1@example.edu,mother\n" +
  "ADM-2024-002,john.smith@example.edu,John,,Smith,,2011-07-22,applicant,,\n";

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function importRoutes(database: Database, redis: RedisClient | null): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const importQueue = redis ? new Queue(QUEUE_NAMES.IMPORTS, { connection: redis as never }) : null;

  // --- Channel guard: web only ---
  const channelGuard = requireChannel(AUTH_CHANNELS.WEB);
  routes.use("/api/imports", channelGuard);
  routes.use("/api/imports/*", channelGuard);

  // --- Permission gates ---
  routes.use("/api/imports/students", requirePermission(PERMISSIONS.STUDENT_IMPORT));
  routes.use("/api/imports/students/*", requirePermission(PERMISSIONS.STUDENT_IMPORT));
  routes.use("/api/imports/students/template", requirePermission(PERMISSIONS.STUDENT_READ));

  // --- Audit declarations ---
  routes.use("/api/imports/students/upload", auditAction("insert", "student_imports"));
  routes.use("/api/imports/students/:importId/confirm", auditAction("update", "student_imports"));
  routes.use("/api/imports/students/:importId/mapping", auditAction("update", "student_imports"));
  routes.use("/api/imports/students/mappings", async (c, next) =>
    c.req.method === "POST" ? auditAction("insert", "student_import_mappings")(c, next) : next(),
  );
  routes.use("/api/imports/students/mappings/:mappingId", async (c, next) =>
    auditAction(c.req.method === "DELETE" ? "delete" : "update", "student_import_mappings")(
      c,
      next,
    ),
  );

  // --- Handlers ---

  routes.openapi(uploadStudentCsvRoute, async (c) => {
    const auth = requireAuth(c);

    // Parse multipart body — Hono delivers raw text/csv when content type matches.
    const rawCsv = await c.req.text();

    if (!rawCsv || rawCsv.trim().length === 0) {
      throw new HTTPException(400, { message: "Request body is empty." });
    }

    const fileName = c.req.header("X-File-Name") ?? "students.csv";
    const { mapping_id } = c.req.valid("query");

    const record = await withTenantTx(database, tenantFrom(c), (tx) =>
      uploadImport(tx, auth.schoolId, auth.userId, fileName, rawCsv, mapping_id),
    );

    return c.json(toResponse(record), 201);
  });

  routes.openapi(confirmStudentImportRoute, async (c) => {
    const auth = requireAuth(c);
    const { importId } = c.req.valid("param");
    const body = c.req.valid("json");

    const record = await withTenantTx(database, tenantFrom(c), (tx) =>
      confirmImport(tx, auth.schoolId, auth.userId, importId, body.idempotency_key),
    );

    // Dispatch async processing to the IMPORTS queue.
    if (importQueue && record.status === "confirmed") {
      await importQueue.add(
        "process-student-import",
        { importId: record.id, schoolId: record.school_id },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: { age: 7 * 24 * 60 * 60 },
          removeOnFail: { age: 30 * 24 * 60 * 60 },
        },
      );
    }

    return c.json(toResponse(record), 200);
  });

  // ST-249: registered ahead of getStudentImportRoute below, not after — Hono resolves an
  // ambiguous path by registration order, not specificity, and "/api/imports/students/template"
  // also matches getStudentImportRoute's "{importId}" pattern with importId="template".
  // Registered after, this route was dead: every request to it hit getImport("template", ...)
  // instead of serving the CSV template.
  routes.openapi(downloadTemplateRoute, async (_c) => {
    return new Response(CSV_TEMPLATE, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="student-import-template.csv"',
      },
    });
  });

  // Registered ahead of getStudentImportRoute for the same reason as the template route above:
  // "/api/imports/students/mappings" also matches its "{importId}" pattern.
  routes.openapi(listStudentImportMappingsRoute, async (c) => {
    const auth = requireAuth(c);
    const mappings = await withTenantTx(database, tenantFrom(c), (tx) =>
      listMappings(tx, auth.schoolId),
    );
    return c.json({ mappings: mappings.map(toMappingResponse) }, 200);
  });

  routes.openapi(createStudentImportMappingRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const mapping = await withTenantTx(database, tenantFrom(c), (tx) =>
      createMapping(tx, auth.schoolId, auth.userId, body.name, body.column_mapping),
    );
    return c.json(toMappingResponse(mapping), 201);
  });

  routes.openapi(updateSavedStudentImportMappingRoute, async (c) => {
    const auth = requireAuth(c);
    const { mappingId } = c.req.valid("param");
    const body = c.req.valid("json");
    const mapping = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateMapping(tx, auth.schoolId, mappingId, body),
    );
    return c.json(toMappingResponse(mapping), 200);
  });

  routes.openapi(deleteStudentImportMappingRoute, async (c) => {
    const auth = requireAuth(c);
    const { mappingId } = c.req.valid("param");
    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteMapping(tx, auth.schoolId, mappingId),
    );
    return new Response(null, { status: 204 });
  });

  routes.openapi(updateStudentImportMappingRoute, async (c) => {
    const auth = requireAuth(c);
    const { importId } = c.req.valid("param");
    const body = c.req.valid("json");
    const record = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateImportMapping(
        tx,
        auth.schoolId,
        auth.userId,
        importId,
        body.column_mapping,
        body.save_as,
      ),
    );
    return c.json(toResponse(record), 200);
  });

  routes.openapi(getStudentImportDiffRoute, async (c) => {
    const auth = requireAuth(c);
    const { importId } = c.req.valid("param");
    const { action } = c.req.valid("query");
    const diff = await withTenantTx(database, tenantFrom(c), (tx) =>
      getImportDiff(tx, auth.schoolId, importId, action),
    );
    return c.json(diff, 200);
  });

  routes.openapi(getStudentImportRoute, async (c) => {
    const auth = requireAuth(c);
    const { importId } = c.req.valid("param");

    const record = await withTenantTx(database, tenantFrom(c), (tx) =>
      getImport(tx, auth.schoolId, importId),
    );

    return c.json(toResponse(record), 200);
  });

  routes.openapi(listStudentImportsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, next_cursor } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listImports(tx, auth.schoolId, query),
    );

    return c.json({ imports: rows.map(toResponse), next_cursor }, 200);
  });

  return routes;
}
