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
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import { confirmImport, getImport, listImports, uploadImport } from "../import-service";
import {
  confirmImportBodySchema,
  importIdParamSchema,
  importListQuerySchema,
  importListSchema,
  importRecordSchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { ImportRecord } from "../import-service";
import type { ImportRecordResponse } from "../schemas";
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
    status: record.status,
    file_name: record.file_name,
    row_count: record.row_count,
    valid_rows: record.valid_rows,
    error_rows: record.error_rows,
    errors: record.errors,
    summary: record.summary,
    created_at: record.created_at.toISOString(),
    updated_at: record.updated_at.toISOString(),
    confirmed_at: record.confirmed_at?.toISOString() ?? null,
    completed_at: record.completed_at?.toISOString() ?? null,
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
    "Uploads a CSV file of students. Validates every row and returns a report with line-level " +
    "errors. The CSV data is stored server-side for later confirmation. Max 10,000 rows.",
  security: [{ bearerAuth: [] }],
  request: {
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
    [400, 401, 403, 429, 500],
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
  routes.use("/api/imports/students/{importId}/confirm", auditAction("update", "student_imports"));

  // --- Handlers ---

  routes.openapi(uploadStudentCsvRoute, async (c) => {
    const auth = requireAuth(c);

    // Parse multipart body — Hono delivers raw text/csv when content type matches.
    const rawCsv = await c.req.text();

    if (!rawCsv || rawCsv.trim().length === 0) {
      throw new HTTPException(400, { message: "Request body is empty." });
    }

    const fileName = c.req.header("X-File-Name") ?? "students.csv";

    const record = await withTenantTx(database, tenantFrom(c), (tx) =>
      uploadImport(tx, auth.schoolId, auth.userId, fileName, rawCsv),
    );

    return c.json(toResponse(record), 201);
  });

  routes.openapi(confirmStudentImportRoute, async (c) => {
    const auth = requireAuth(c);
    const { importId } = c.req.valid("param");
    const body = c.req.valid("json");

    const record = await withTenantTx(database, tenantFrom(c), (tx) =>
      confirmImport(tx, auth.schoolId, importId, body.idempotency_key),
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

  routes.openapi(downloadTemplateRoute, async (_c) => {
    return new Response(CSV_TEMPLATE, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="student-import-template.csv"',
      },
    });
  });

  return routes;
}
