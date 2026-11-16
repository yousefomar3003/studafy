import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ERROR_CODES,
  INGESTION_JOB_OPTIONS,
  JOB_NAMES,
  PERMISSIONS,
  QUEUE_NAMES,
} from "@studafy/constants";
import { Queue } from "bullmq";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../../coded-http-exception";
import { tenantTxRunner, withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { onlyMethods } from "../../../middleware/only-methods";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import { freeStoredObjects } from "../../storage/free-objects";
import { assertStorageUploadQuota, recordStorageUpload } from "../../storage/quota-service";
import {
  confirmUpload,
  deleteMaterial,
  getMaterial,
  getRetryableMaterial,
  initiateUpload,
  listMaterials,
  materialVisibilityFor,
  retryFailedMaterial,
  toggleAiVisible,
  updateMaterial,
} from "../material-service";
import {
  confirmUploadBodySchema,
  createMaterialBodySchema,
  materialIdParamSchema,
  materialListSchema,
  materialQuerySchema,
  materialSchema,
  presignedUploadResponseSchema,
  toggleAiVisibleBodySchema,
  updateMaterialBodySchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { ScannerWarmup } from "../../../lib/scanner-warmup";
import type { StorageService } from "../../../lib/storage";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { MaterialRow } from "../material-service";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listMaterialsRoute = createRoute({
  method: "get",
  path: "/api/academics/materials",
  tags: ["Academics"],
  operationId: "listMaterials",
  summary: "List materials",
  description:
    "Paginated list of materials for the authenticated school, ordered by creation date " +
    "descending. Filter by class, ingest status, and the week and day of the term. School staff " +
    "see every pipeline state; students, parents and other non-staff callers see only `ready` " +
    "materials (the ones they can open).",
  security: [{ bearerAuth: [] }],
  request: { query: materialQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of materials.",
        schema: materialListSchema,
      },
    },
    [401, 403, 500],
  ),
});

const getMaterialRoute = createRoute({
  method: "get",
  path: "/api/academics/materials/{materialId}",
  tags: ["Academics"],
  operationId: "getMaterial",
  summary: "Get a material",
  description:
    "Returns a single material by ID. For a caller who is not school staff, a material that is " +
    "not `ready` answers 404, as if it did not exist.",
  security: [{ bearerAuth: [] }],
  request: { params: materialIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The material.",
        schema: materialSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const initiateMaterialUploadRoute = createRoute({
  method: "post",
  path: "/api/academics/materials/upload",
  tags: ["Academics"],
  operationId: "initiateMaterialUpload",
  summary: "Initiate a material upload",
  description:
    "Creates a material record and returns a pre-signed upload URL. " +
    "The client uploads the file directly to storage, then calls the confirm endpoint. " +
    "Requires material:create, and the caller must teach the class or be the school admin.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createMaterialBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "Material record created, pre-signed upload URL ready.",
        schema: presignedUploadResponseSchema,
      },
    },
    [400, 401, 402, 403, 404, 409, 500],
  ),
});

const confirmMaterialUploadRoute = createRoute({
  method: "post",
  path: "/api/academics/materials/{materialId}/confirm",
  tags: ["Academics"],
  operationId: "confirmMaterialUpload",
  summary: "Confirm a material upload",
  description:
    "Confirms that the file was uploaded to storage. Transitions the material to " +
    "scanning state and enqueues a malware scan. The scan worker flips a clean, AI-visible " +
    "material to queued and enqueues AI ingestion (which flips it to ready), a clean non-AI " +
    "material straight to ready, and an infected material to quarantined. Requires " +
    "material:create, and the caller must teach the material's class or be the school admin.",
  security: [{ bearerAuth: [] }],
  request: {
    params: materialIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: confirmUploadBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Material confirmed, now in scanning state.",
        schema: materialSchema,
      },
    },
    [400, 401, 402, 403, 404, 409, 500],
  ),
});

const retryMaterialRoute = createRoute({
  method: "post",
  path: "/api/academics/materials/{materialId}/retry",
  tags: ["Academics"],
  operationId: "retryMaterial",
  summary: "Retry a failed material",
  description:
    "Sends a failed material back through the pipeline: it returns to scanning (its error " +
    "cleared) and a malware scan is enqueued, exactly as after confirm. Only a `failed` material " +
    "whose file is still in storage can be retried (409 otherwise); a quarantined one never can. " +
    "Requires material:update, and the caller must teach the material's class or be the school " +
    "admin.",
  security: [{ bearerAuth: [] }],
  request: { params: materialIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "Material is scanning again.",
        schema: materialSchema,
      },
    },
    [401, 403, 404, 409, 500],
  ),
});

const updateMaterialRoute = createRoute({
  method: "patch",
  path: "/api/academics/materials/{materialId}",
  tags: ["Academics"],
  operationId: "updateMaterial",
  summary: "Update a material",
  description:
    "Partially updates material metadata (title, description, and the week and day of the term " +
    "it is listed under). week_number and day_of_week are sent together: both numbers move it, " +
    "both null make it unscheduled, both omitted leave it where it is. Requires material:update, " +
    "and the caller must teach the material's class or be the school admin.",
  security: [{ bearerAuth: [] }],
  request: {
    params: materialIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateMaterialBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated material.",
        schema: materialSchema,
      },
    },
    [400, 401, 403, 404, 500],
  ),
});

const deleteMaterialRoute = createRoute({
  method: "delete",
  path: "/api/academics/materials/{materialId}",
  tags: ["Academics"],
  operationId: "deleteMaterial",
  summary: "Delete a material",
  description:
    "Deletes a material and its associated AI chunks (cascaded). " +
    "Its stored file, thumbnail and preview are removed and their space freed once the delete " +
    "has committed. Requires material:delete, and the caller must teach the material's class or " +
    "be the school admin.",
  security: [{ bearerAuth: [] }],
  request: { params: materialIdParamSchema },
  responses: {
    204: { description: "Material deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

const toggleAiVisibleRoute = createRoute({
  method: "patch",
  path: "/api/academics/materials/{materialId}/ai-visible",
  tags: ["Academics"],
  operationId: "toggleMaterialAiVisible",
  summary: "Toggle AI visibility",
  description:
    "Sets whether a material is exposed to AI ingestion. Disabling removes all " +
    "associated chunks and resets ingest status. Enabling queues the material for ingestion. " +
    "Requires material:manageAi, and the caller must teach the material's class or lead the school.",
  security: [{ bearerAuth: [] }],
  request: {
    params: materialIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: toggleAiVisibleBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The material with updated AI visibility.",
        schema: materialSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

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

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export interface MaterialRoutesOptions {
  /** Wakes the scaled-to-zero scanner when an upload starts. Fire-and-forget; absent: no warm-up. */
  scannerWarmup?: ScannerWarmup | null;
}

export function materialRoutes(
  database: Database,
  storage?: StorageService | null,
  redis?: RedisClient | null,
  options: MaterialRoutesOptions = {},
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // One queue handle per process, like importRoutes. Null when Redis is unavailable: the confirm
  // endpoint still flips the material to 'scanning' and answers 200, and the scan simply never
  // runs — the same degraded mode the import and report producers use.
  const scanQueue = redis ? new Queue(QUEUE_NAMES.SCAN, { connection: redis as never }) : null;

  // The ai-ingestion producer for AI re-enable: a 'ready' material whose ai_visible is turned back
  // on is re-staged to 'queued' (ST-161) and an ingest job is enqueued so it is re-chunked without
  // a fresh upload. Same degraded mode as scanQueue when Redis is unavailable.
  const ingestionQueue = redis
    ? new Queue(QUEUE_NAMES.AI_INGESTION, { connection: redis as never })
    : null;

  // Hand a material in 'scanning' to the file-scan worker (confirm and retry). The status flip is
  // the claim: the worker only touches materials still in 'scanning', so a retry (or a duplicate
  // enqueue) can never scan the same object twice or notify the uploader twice.
  async function enqueueScan(schoolId: string, row: MaterialRow): Promise<void> {
    if (!scanQueue || row.ingest_status !== "scanning") return;
    await scanQueue.add(
      JOB_NAMES.SCAN_MATERIAL,
      {
        schoolId,
        materialId: row.id,
        storageKey: row.storage_key,
        uploadedByUserId: row.uploaded_by_user_id,
      },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60 },
        removeOnFail: { age: 30 * 24 * 60 * 60 },
      },
    );
  }

  // Audit declarations
  routes.use("/api/academics/materials/upload", auditAction("insert", "materials"));
  routes.use("/api/academics/materials/:materialId", auditAction("update", "materials"));
  routes.use("/api/academics/materials/:materialId/confirm", auditAction("update", "materials"));
  routes.use("/api/academics/materials/:materialId/retry", auditAction("update", "materials"));
  routes.use("/api/academics/materials/:materialId/ai-visible", auditAction("update", "materials"));

  // Writes are staff work. Reads stay open to everyone who can read the class (RLS), but writing
  // needs the material permission -- teachers and the school admin hold create/update/delete,
  // students and parents hold none -- and the service then narrows a teacher to the classes they
  // teach (assertCanWriteClassMaterials). Confirm is the second half of an upload, so it takes
  // material:create. AI visibility takes material:manageAi, the permission the class-wide AI
  // materials setting uses, so the principal who may switch a whole class off may also switch off
  // one material.
  routes.use("/api/academics/materials/upload", requirePermission(PERMISSIONS.MATERIAL_CREATE));
  routes.use(
    "/api/academics/materials/:materialId/confirm",
    requirePermission(PERMISSIONS.MATERIAL_CREATE),
  );
  routes.use(
    "/api/academics/materials/:materialId/retry",
    requirePermission(PERMISSIONS.MATERIAL_UPDATE),
  );
  routes.use(
    "/api/academics/materials/:materialId/ai-visible",
    requirePermission(PERMISSIONS.MATERIAL_MANAGE_AI),
  );
  // GET on the same path stays open; only PATCH and DELETE are writes. "upload" also matches
  // :materialId, but as a POST it is neither.
  routes.use(
    "/api/academics/materials/:materialId",
    onlyMethods(["PATCH"], requirePermission(PERMISSIONS.MATERIAL_UPDATE)),
  );
  routes.use(
    "/api/academics/materials/:materialId",
    onlyMethods(["DELETE"], requirePermission(PERMISSIONS.MATERIAL_DELETE)),
  );

  routes.openapi(listMaterialsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listMaterials(tx, auth.schoolId, query, materialVisibilityFor(auth.roles)),
    );

    return c.json({ materials: rows, total }, 200);
  });

  routes.openapi(getMaterialRoute, async (c) => {
    const auth = requireAuth(c);
    const { materialId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getMaterial(tx, auth.schoolId, materialId, materialVisibilityFor(auth.roles)),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Material not found" });
    }

    return c.json(row, 200);
  });

  routes.openapi(initiateMaterialUploadRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    if (!storage) {
      throw new HTTPException(503, { message: "Storage not configured" });
    }

    // The scanner scales to zero; start it now so it boots while the file uploads rather than after
    // confirm. Unawaited and error-proof (lib/scanner-warmup.ts): it never delays this request.
    options.scannerWarmup?.();

    // Claim-based quota check before the material row is created or a PUT is signed. Materials
    // upload straight into permanent/, so there is no temp/ stage to refuse at -- this gate plus
    // the daily reconciliation is the enforcement boundary for this flow.
    const result = await withTenantTx(database, tenantFrom(c), async (tx) => {
      await assertStorageUploadQuota(tx, body.size_bytes);
      return initiateUpload(tx, auth.schoolId, auth.userId, body);
    });

    // The teacher's earlier failed attempt at this file was replaced; free its stored file now that
    // the delete has committed, the way deleting a material does.
    await freeStoredObjects(
      storage,
      tenantTxRunner(database, tenantFrom(c)),
      auth.schoolId,
      result.freedStorageKeys,
    );

    const presigned = await storage.presign(result.storage_key, "PUT", body.mime_type);

    return c.json(
      {
        upload_url: presigned.url,
        storage_key: result.storage_key,
        expires_at: presigned.expiresAt.toISOString(),
      },
      201,
    );
  });

  routes.openapi(confirmMaterialUploadRoute, async (c) => {
    const auth = requireAuth(c);
    const { materialId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const confirmed = await confirmUpload(
        tx,
        auth.schoolId,
        materialId,
        body.storage_key,
        body.checksum_sha256,
      );
      // The material's size is the client's claim from initiate; the object is already in
      // permanent/ by now. The meter is credited so enforcement stays fresh, and reconciliation
      // corrects any gap between the claim and the stored bytes.
      await recordStorageUpload(tx, confirmed.size_bytes);
      return confirmed;
    });

    await enqueueScan(auth.schoolId, row);

    return c.json(row, 200);
  });

  routes.openapi(retryMaterialRoute, async (c) => {
    const auth = requireAuth(c);
    const { materialId } = c.req.valid("param");

    const failed = await withTenantTx(database, tenantFrom(c), (tx) =>
      getRetryableMaterial(tx, auth.schoolId, materialId),
    );

    // A retry re-scans the stored file, so it must still be there. A failed material keeps its
    // object, but the abandoned-material sweep or a storage incident may have removed it since.
    if (!storage) {
      throw new HTTPException(503, { message: "Storage not configured" });
    }
    if (!(await storage.head(failed.storage_key))) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.MATERIAL_STORAGE_CONFIRM_FAILED,
        "The file is no longer in storage. Delete this material and upload it again.",
      );
    }

    // Same head start as a fresh upload: the scan job follows straight away.
    options.scannerWarmup?.();

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      retryFailedMaterial(tx, auth.schoolId, materialId),
    );
    await enqueueScan(auth.schoolId, row);

    return c.json(row, 200);
  });

  routes.openapi(updateMaterialRoute, async (c) => {
    const auth = requireAuth(c);
    const { materialId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateMaterial(tx, auth.schoolId, materialId, auth.userId, body),
    );

    return c.json(row, 200);
  });

  routes.openapi(deleteMaterialRoute, async (c) => {
    const auth = requireAuth(c);
    const { materialId } = c.req.valid("param");

    const { storageKeys } = await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteMaterial(tx, auth.schoolId, materialId),
    );
    await freeStoredObjects(
      storage,
      tenantTxRunner(database, tenantFrom(c)),
      auth.schoolId,
      storageKeys,
    );

    return c.body(null, 204);
  });

  routes.openapi(toggleAiVisibleRoute, async (c) => {
    const auth = requireAuth(c);
    const { materialId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      toggleAiVisible(tx, auth.schoolId, materialId, body.ai_visible),
    );

    // Enabling re-stages a previously ingested material to 'queued' (the service flips it there).
    // Hand it to the ai-ingestion worker: the claim on 'queued' makes a duplicate enqueue a no-op,
    // so re-enabling a material with an ingest already in flight cannot double-ingest it.
    if (body.ai_visible && row.ingest_status === "queued" && ingestionQueue) {
      await ingestionQueue.add(
        JOB_NAMES.INGEST_MATERIAL,
        { version: 1, schoolId: auth.schoolId, materialId: row.id },
        INGESTION_JOB_OPTIONS,
      );
    }

    return c.json(row, 200);
  });

  return routes;
}
