import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, INGESTION_JOB_OPTIONS, JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { tenantTxRunner, withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { getLocalizedMessage } from "../../../middleware/locale";
import { onlyMethods } from "../../../middleware/only-methods";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import { getFeatureService } from "../../features/middleware";
import { freeStoredObjects } from "../../storage/free-objects";
import { assertStorageUploadQuota } from "../../storage/quota-service";
import { AI_REFUSAL_CODES, aiStudentSubject } from "../gate/token-budget";
import { moderateInput } from "../moderation/moderate";
import {
  AI_SOURCE_MAX_FILE_BYTES,
  AI_SOURCE_MIME_TYPES,
  AI_SOURCE_RETENTION_DAYS,
  isAiSourceMimeType,
} from "../sources/limits";
import {
  confirmPersonalUpload,
  deletePersonalSource,
  getSource,
  initiatePersonalUpload,
  listAssignmentSourceCandidates,
  listPersonalSources,
  personalSourceUsage,
  prepareAssignmentSource,
} from "../sources/service";

import type { Database } from "../../../db/client";
import type { ScannerWarmup } from "../../../lib/scanner-warmup";
import type { StorageService } from "../../../lib/storage";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { AiSourceRow } from "../sources/service";
import type { Context, MiddlewareHandler } from "hono";

/**
 * A student's own AI sources (000232), besides their classes' study materials:
 *
 *   GET    /api/ai/students/{studentId}/sources                         their files and photos
 *   POST   /api/ai/students/{studentId}/sources/upload                  start an upload
 *   POST   /api/ai/students/{studentId}/sources/{sourceId}/confirm      finish it: scan, then ingest
 *   GET    /api/ai/students/{studentId}/sources/{sourceId}              one source (either kind)
 *   DELETE /api/ai/students/{studentId}/sources/{sourceId}              delete a file or photo
 *   GET    /api/ai/students/{studentId}/assignment-sources              their assignments
 *   POST   /api/ai/students/{studentId}/assignment-sources/{assignmentId}  build / refresh one
 *
 * A source's id is a material id, so every AI tool (summary, key concepts, quiz, flashcards,
 * practice exam, Ask AI, explain) takes it exactly where it takes a study material, and every tool's
 * own gate, quota and usage meter applies unchanged. Nothing here calls the model or spends tokens,
 * so these routes sit outside the consent gate and the token budget (consent/disclosure.ts), and are
 * gated only on the student holding an AI feature at all (ai_tutor or study_tools): the sources are
 * worth keeping only to someone who can use them.
 *
 * Privacy: `/api/ai/students/{studentId}/*` is the student's own (student-self gate), and the
 * role-scope policy shows a personal source to its owner alone (000232), so nothing here can read
 * or touch another student's files. An assignment source is the class's: visible as the assignment
 * is.
 *
 * Every upload goes through the material pipeline: a presigned PUT into permanent/, confirm (which
 * reads the stored size and type back from the bucket, rather than trusting the client), the ClamAV
 * scan, then parse / OCR / chunk. The bytes count on the school's storage meter and quota, and the
 * per-student caps in sources/limits.ts sit inside that.
 */

const SOURCE_KINDS = ["personal", "assignment"] as const;
const SOURCE_STATUSES = [
  "uploaded",
  "scanning",
  "queued",
  "processing",
  "ready",
  "failed",
  "quarantined",
] as const;

const aiSourceSchema = z
  .object({
    id: z.string().uuid().openapi({
      description: "The source's id: pass it to any AI tool wherever a material id goes.",
    }),
    kind: z.enum(SOURCE_KINDS).openapi({
      description: "personal = the student's own file or photo; assignment = an assignment.",
    }),
    title: z.string(),
    original_file_name: z.string().nullable(),
    mime_type: z.string(),
    size_bytes: z.number(),
    status: z.enum(SOURCE_STATUSES).openapi({
      description:
        "Pipeline state: uploaded (waiting for the file), scanning (malware scan), queued / " +
        "processing (reading the text, OCR for photos), ready, failed, or quarantined (blocked).",
    }),
    error: z.string().nullable(),
    has_text: z.boolean().openapi({
      description: "True once text was found; a ready source without text cannot be used.",
    }),
    assignment_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("AiSource");

const aiSourceUsageSchema = z
  .object({
    count: z.number().int(),
    bytes: z.number(),
    max_count: z.number().int(),
    max_bytes: z.number(),
    max_file_bytes: z.number(),
    retention_days: z.number().int(),
  })
  .openapi("AiSourceUsage");

const aiSourceListSchema = z
  .object({
    sources: z.array(aiSourceSchema),
    usage: aiSourceUsageSchema,
    accepted_mime_types: z.array(z.string()),
  })
  .openapi("AiSourceList");

const aiSourceUploadBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional().openapi({
      description: "A name for the source; defaults to the file name.",
    }),
    original_file_name: z.string().trim().min(1).max(255).openapi({ example: "biology-notes.pdf" }),
    mime_type: z
      .string()
      .min(1)
      .max(127)
      .openapi({
        description: `One of ${AI_SOURCE_MIME_TYPES.join(", ")}.`,
        example: "application/pdf",
      }),
    size_bytes: z
      .number()
      .int()
      .min(1)
      .openapi({
        description: `The file's size; at most ${AI_SOURCE_MAX_FILE_BYTES} bytes.`,
      }),
  })
  .openapi("AiSourceUploadBody");

const aiSourceUploadResponseSchema = z
  .object({
    source: aiSourceSchema,
    upload_url: z.string(),
    storage_key: z.string(),
    expires_at: z.string(),
  })
  .openapi("AiSourceUploadResponse");

const aiSourceConfirmBodySchema = z
  .object({ storage_key: z.string().min(1) })
  .openapi("AiSourceConfirmBody");

const aiAssignmentSourceSchema = z
  .object({
    assignment_id: z.string().uuid(),
    title: z.string(),
    class_id: z.string().uuid(),
    class_code: z.string().nullable(),
    due_at: z.string(),
    attachment_count: z.number().int(),
    ai_enabled: z.boolean().openapi({
      description: "False when the school turned the AI study tools off for this class.",
    }),
    source_id: z.string().uuid().nullable(),
    source_status: z.enum(SOURCE_STATUSES).nullable(),
  })
  .openapi("AiAssignmentSource");

const aiAssignmentSourceListSchema = z
  .object({ assignments: z.array(aiAssignmentSourceSchema) })
  .openapi("AiAssignmentSourceList");

const studentParamSchema = z.object({
  studentId: z
    .string()
    .uuid()
    .openapi({ param: { name: "studentId", in: "path" } }),
});

const sourceParamSchema = studentParamSchema.extend({
  sourceId: z
    .string()
    .uuid()
    .openapi({ param: { name: "sourceId", in: "path" } }),
});

const assignmentParamSchema = studentParamSchema.extend({
  assignmentId: z
    .string()
    .uuid()
    .openapi({ param: { name: "assignmentId", in: "path" } }),
});

const listSourcesRoute = createRoute({
  method: "get",
  path: "/api/ai/students/{studentId}/sources",
  tags: ["AI"],
  operationId: "listAiSources",
  summary: "List the student's own AI sources",
  description:
    "The files and photos the student uploaded for the AI study tools, newest first, with their " +
    "pipeline state and the per-student limits. Visible to the student only.",
  security: [{ bearerAuth: [] }],
  request: { params: studentParamSchema },
  responses: standardResponses(
    { 200: { description: "The student's sources.", schema: aiSourceListSchema } },
    [401, 402, 403, 500],
  ),
});

const uploadSourceRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/sources/upload",
  tags: ["AI"],
  operationId: "initiateAiSourceUpload",
  summary: "Start uploading a file or photo as an AI source",
  description:
    "Creates the source and returns a pre-signed URL to PUT the file to; then call confirm. " +
    "Accepts PDF, Word, PowerPoint, JPEG and PNG. Refuses 422 AI_SOURCE_UNSUPPORTED_TYPE, " +
    "AI_SOURCE_TOO_LARGE or AI_SOURCE_LIMIT_REACHED (the student's own caps), and 402 when the " +
    "school's storage is full.",
  security: [{ bearerAuth: [] }],
  request: {
    params: studentParamSchema,
    body: { required: true, content: { "application/json": { schema: aiSourceUploadBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "Upload URL issued.", schema: aiSourceUploadResponseSchema } },
    [400, 401, 402, 403, 422, 500, 503],
  ),
});

const confirmSourceRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/sources/{sourceId}/confirm",
  tags: ["AI"],
  operationId: "confirmAiSourceUpload",
  summary: "Finish uploading an AI source",
  description:
    "Checks the stored file (its real size and type, read from storage), counts it on the " +
    "school's storage, and sends it to the malware scan; a clean file is then read (OCR for a " +
    "photo) and becomes ready.",
  security: [{ bearerAuth: [] }],
  request: {
    params: sourceParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: aiSourceConfirmBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The source, now scanning.", schema: aiSourceSchema } },
    [400, 401, 402, 403, 404, 409, 422, 500, 503],
  ),
});

const getSourceRoute = createRoute({
  method: "get",
  path: "/api/ai/students/{studentId}/sources/{sourceId}",
  tags: ["AI"],
  operationId: "getAiSource",
  summary: "Get one AI source",
  description: "One of the student's own sources, or an assignment source, with its state.",
  security: [{ bearerAuth: [] }],
  request: { params: sourceParamSchema },
  responses: standardResponses(
    { 200: { description: "The source.", schema: aiSourceSchema } },
    [401, 402, 403, 404, 500],
  ),
});

const deleteSourceRoute = createRoute({
  method: "delete",
  path: "/api/ai/students/{studentId}/sources/{sourceId}",
  tags: ["AI"],
  operationId: "deleteAiSource",
  summary: "Delete one of the student's own AI sources",
  description:
    "Deletes the file or photo, its text, and everything the AI tools grounded on it; the stored " +
    "file is removed and its space freed.",
  security: [{ bearerAuth: [] }],
  request: { params: sourceParamSchema },
  responses: {
    204: { description: "Source deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 402, 403, 404, 500]),
  },
});

const listAssignmentSourcesRoute = createRoute({
  method: "get",
  path: "/api/ai/students/{studentId}/assignment-sources",
  tags: ["AI"],
  operationId: "listAiAssignmentSources",
  summary: "List the student's assignments usable as AI sources",
  description:
    "The student's published assignments in the classes they are enrolled in, most recent due " +
    "date first, each with its AI source's state when it has been built.",
  security: [{ bearerAuth: [] }],
  request: { params: studentParamSchema },
  responses: standardResponses(
    { 200: { description: "The assignments.", schema: aiAssignmentSourceListSchema } },
    [401, 402, 403, 500],
  ),
});

const prepareAssignmentSourceRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/assignment-sources/{assignmentId}",
  tags: ["AI"],
  operationId: "prepareAiAssignmentSource",
  summary: "Use an assignment as an AI source",
  description:
    "Returns the assignment's AI source, building it the first time (or rebuilding it after the " +
    "assignment changed) from its instructions and the teacher's attached files. Poll the source " +
    "until it is ready. 404 for an assignment the student cannot see; 422 " +
    "AI_SOURCE_AI_DISABLED when the class's AI study tools are off.",
  security: [{ bearerAuth: [] }],
  request: { params: assignmentParamSchema },
  responses: standardResponses(
    { 200: { description: "The assignment's source.", schema: aiSourceSchema } },
    [401, 402, 403, 404, 422, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function refuse(
  c: Context<AppEnv>,
  status: 400 | 402 | 403 | 404 | 409 | 422 | 503,
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
): CodedHttpException {
  const locale = (c.get("locale") ?? "en") as SupportedLocale;
  return new CodedHttpException(status, code, getLocalizedMessage(code, locale));
}

function wire(row: AiSourceRow) {
  return {
    ...row,
    status: row.status as (typeof SOURCE_STATUSES)[number],
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * The student holds an AI feature: Ask AI (ai_tutor) or the study tools (study_tools). Either one
 * makes their sources useful, so either admits; neither refuses the way the study tools would.
 * Checked, never metered.
 */
function requireAnyAiFeature(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = requireAuth(c);
    const subject = aiStudentSubject(c);
    if (!subject) throw refuse(c, 403, ERROR_CODES.AUTHZ_FORBIDDEN);
    const resolved = await getFeatureService(c).resolve(auth.schoolId, subject);
    const tutor = resolved.features.ai_tutor;
    const tools = resolved.features.study_tools;
    if (!tutor.active && !tools.active) {
      if (tools.reason === "school_inactive" || tutor.reason === "school_inactive") {
        throw refuse(c, 403, AI_REFUSAL_CODES.schoolInactive);
      }
      throw refuse(c, 402, AI_REFUSAL_CODES.notIncluded);
    }
    await next();
  };
}

export function aiSourceRoutes(deps: {
  database: Database;
  storage?: StorageService | null;
  redis?: RedisClient | null;
  /** Wakes the scaled-to-zero scanner when an upload starts. */
  scannerWarmup?: ScannerWarmup | null;
  /** Test seams for the queues; default to BullMQ producers on `redis` (none without it). */
  enqueueScan?: (data: {
    schoolId: string;
    materialId: string;
    storageKey: string;
    uploadedByUserId: string;
  }) => Promise<void>;
  enqueueIngestion?: (schoolId: string, materialId: string) => Promise<void>;
}): OpenAPIHono<AppEnv> {
  const { database, storage = null, redis = null, scannerWarmup = null } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // One producer per process, like materialRoutes. Without Redis the source stays in its state and
  // simply never moves on -- the same degraded mode the material upload has.
  const scanQueue =
    !deps.enqueueScan && redis ? new Queue(QUEUE_NAMES.SCAN, { connection: redis as never }) : null;
  const ingestionQueue =
    !deps.enqueueIngestion && redis
      ? new Queue(QUEUE_NAMES.AI_INGESTION, { connection: redis as never })
      : null;

  const enqueueScan =
    deps.enqueueScan ??
    (async (data: {
      schoolId: string;
      materialId: string;
      storageKey: string;
      uploadedByUserId: string;
    }) => {
      if (!scanQueue) return;
      await scanQueue.add(JOB_NAMES.SCAN_MATERIAL, data, {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60 },
        removeOnFail: { age: 30 * 24 * 60 * 60 },
      });
    });
  const enqueueIngestion =
    deps.enqueueIngestion ??
    (async (schoolId: string, materialId: string) => {
      if (!ingestionQueue) return;
      await ingestionQueue.add(
        JOB_NAMES.INGEST_MATERIAL,
        { version: 1, schoolId, materialId },
        INGESTION_JOB_OPTIONS,
      );
    });

  const gate = requireAnyAiFeature();
  routes.use("/api/ai/students/:studentId/sources", gate);
  routes.use("/api/ai/students/:studentId/sources/*", gate);
  routes.use("/api/ai/students/:studentId/assignment-sources", gate);
  routes.use("/api/ai/students/:studentId/assignment-sources/*", gate);

  // Audit intent for the mutating routes (tests/audit-coverage.test.ts); the service writes the rows.
  routes.use("/api/ai/students/:studentId/sources/upload", auditAction("insert", "materials"));
  routes.use(
    "/api/ai/students/:studentId/sources/:sourceId/confirm",
    auditAction("update", "materials"),
  );
  routes.use(
    "/api/ai/students/:studentId/sources/:sourceId",
    onlyMethods(["DELETE"], auditAction("delete", "materials")),
  );
  routes.use(
    "/api/ai/students/:studentId/assignment-sources/:assignmentId",
    auditAction("insert", "materials"),
  );

  routes.openapi(listSourcesRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const { sources, usage } = await withTenantTx(database, tenantFrom(c), async (tx) => ({
      sources: await listPersonalSources(tx, auth.schoolId, studentId),
      usage: await personalSourceUsage(tx, auth.schoolId, studentId),
    }));
    return c.json(
      {
        sources: sources.map(wire),
        usage: {
          ...usage,
          max_file_bytes: AI_SOURCE_MAX_FILE_BYTES,
          retention_days: AI_SOURCE_RETENTION_DAYS,
        },
        accepted_mime_types: [...AI_SOURCE_MIME_TYPES],
      },
      200,
    );
  });

  routes.openapi(uploadSourceRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const body = c.req.valid("json");

    if (!isAiSourceMimeType(body.mime_type)) {
      throw refuse(c, 422, ERROR_CODES.AI_SOURCE_UNSUPPORTED_TYPE);
    }
    if (body.size_bytes > AI_SOURCE_MAX_FILE_BYTES) {
      throw refuse(c, 422, ERROR_CODES.AI_SOURCE_TOO_LARGE);
    }
    const fileName = body.original_file_name.replace(/[/\\]/g, "_");
    const title = body.title ?? fileName.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();
    // The title is the one thing here the student types, and it reaches the model as the source's
    // name: it gets the same input check as an Ask AI question. The file's own text is source
    // material, handled like a teacher's (the tools' prompts treat it as data, and their output is
    // moderated); a pattern check over a whole document would block ordinary textbooks.
    if (moderateInput(title).blocked) {
      throw refuse(c, 400, ERROR_CODES.AI_MODERATION_INPUT_BLOCKED);
    }
    if (!storage) throw refuse(c, 503, ERROR_CODES.STORAGE_NOT_CONFIGURED);

    scannerWarmup?.();

    const result = await withTenantTx(database, tenantFrom(c), async (tx) => {
      await assertStorageUploadQuota(tx, body.size_bytes);
      return initiatePersonalUpload(tx, {
        schoolId: auth.schoolId,
        userId: auth.userId,
        studentId,
        title: title === "" ? fileName : title,
        originalFileName: fileName,
        mimeType: body.mime_type,
        sizeBytes: body.size_bytes,
      });
    });

    const presigned = await storage.presign(result.storageKey, "PUT", body.mime_type);
    return c.json(
      {
        source: wire(result.source),
        upload_url: presigned.url,
        storage_key: result.storageKey,
        expires_at: presigned.expiresAt.toISOString(),
      },
      201,
    );
  });

  routes.openapi(confirmSourceRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId, sourceId } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!storage) throw refuse(c, 503, ERROR_CODES.STORAGE_NOT_CONFIGURED);
    // Only ever a key this route issued; whether it is this student's is checked in the transaction.
    if (!body.storage_key.startsWith(`permanent/${auth.schoolId}/ai-sources/`)) {
      throw refuse(c, 409, ERROR_CODES.CONFLICT_STATE_MISMATCH);
    }

    // The stored object, not the client's claim: its real size is what is metered and capped, and
    // its type is the one the PUT was signed for. An oversized or mistyped file is refused and left
    // unconfirmed; the abandoned-material sweep removes it with its row the next day.
    const stored = await storage.head(body.storage_key);
    if (!stored) throw refuse(c, 409, ERROR_CODES.MATERIAL_STORAGE_CONFIRM_FAILED);
    if (stored.sizeBytes > AI_SOURCE_MAX_FILE_BYTES) {
      throw refuse(c, 422, ERROR_CODES.AI_SOURCE_TOO_LARGE);
    }
    if (!isAiSourceMimeType(stored.contentType.split(";")[0]!.trim().toLowerCase())) {
      throw refuse(c, 422, ERROR_CODES.AI_SOURCE_UNSUPPORTED_TYPE);
    }

    const { source, uploadedByUserId } = await withTenantTx(database, tenantFrom(c), async (tx) => {
      // Re-checked against the stored size: a client cannot pass the quota with a small claim.
      if (stored.sizeBytes > 0) await assertStorageUploadQuota(tx, stored.sizeBytes);
      return confirmPersonalUpload(tx, {
        schoolId: auth.schoolId,
        studentId,
        sourceId,
        storageKey: body.storage_key,
        storedSizeBytes: Math.max(1, stored.sizeBytes),
      });
    });

    if (source.status === "scanning") {
      await enqueueScan({
        schoolId: auth.schoolId,
        materialId: source.id,
        storageKey: body.storage_key,
        uploadedByUserId,
      });
    }
    return c.json(wire(source), 200);
  });

  routes.openapi(getSourceRoute, async (c) => {
    const auth = requireAuth(c);
    const { sourceId } = c.req.valid("param");
    const source = await withTenantTx(database, tenantFrom(c), (tx) =>
      getSource(tx, auth.schoolId, sourceId),
    );
    if (!source) throw refuse(c, 404, ERROR_CODES.RESOURCE_NOT_FOUND);
    return c.json(wire(source), 200);
  });

  routes.openapi(deleteSourceRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId, sourceId } = c.req.valid("param");
    const { storageKeys } = await withTenantTx(database, tenantFrom(c), (tx) =>
      deletePersonalSource(tx, auth.schoolId, studentId, sourceId),
    );
    await freeStoredObjects(
      storage,
      tenantTxRunner(database, tenantFrom(c)),
      auth.schoolId,
      storageKeys,
    );
    return c.body(null, 204);
  });

  routes.openapi(listAssignmentSourcesRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const rows = await withTenantTx(database, tenantFrom(c), (tx) =>
      listAssignmentSourceCandidates(tx, auth.schoolId, studentId),
    );
    return c.json(
      {
        assignments: rows.map((row) => ({
          ...row,
          due_at: row.due_at.toISOString(),
          source_status: row.source_status as (typeof SOURCE_STATUSES)[number] | null,
        })),
      },
      200,
    );
  });

  routes.openapi(prepareAssignmentSourceRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId, assignmentId } = c.req.valid("param");
    const prepared = await withTenantTx(database, tenantFrom(c), (tx) =>
      prepareAssignmentSource(tx, { schoolId: auth.schoolId, studentId, assignmentId }),
    );
    if (prepared.enqueue) {
      await enqueueIngestion(auth.schoolId, prepared.source.id);
    }
    return c.json(wire(prepared.source), 200);
  });

  return routes;
}
