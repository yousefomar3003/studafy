import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { INGESTION_JOB_OPTIONS, JOB_NAMES, PERMISSIONS, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";
import { HTTPException } from "hono/http-exception";

import { tenantTxRunner, withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { onlyMethods } from "../../../middleware/only-methods";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import { getContentClass } from "../../storage/content-classes";
import { freeStoredObjects } from "../../storage/free-objects";
import { assertStorageUploadQuota } from "../../storage/quota-service";
import { inspectStagedUpload } from "../../storage/service";
import {
  copyStagedUploads,
  discardStagedUploads,
  reserveStorage,
} from "../../storage/staged-promotion";
import {
  beginConfirmUpload,
  deleteMaterial,
  finishConfirmUpload,
  getMaterial,
  initiateUpload,
  listMaterials,
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
import type { StorageService } from "../../../lib/storage";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
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
    "Paginated list of materials for the authenticated school, ordered by creation date descending.",
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
  description: "Returns a single material by ID.",
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
    "The client uploads the file directly to storage, then calls the confirm endpoint.",
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
    "material straight to ready, and an infected material to quarantined.",
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

const updateMaterialRoute = createRoute({
  method: "patch",
  path: "/api/academics/materials/{materialId}",
  tags: ["Academics"],
  operationId: "updateMaterial",
  summary: "Update a material",
  description: "Partially updates material metadata (title, description).",
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
    "has committed.",
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
    "associated chunks and resets ingest status. Enabling queues the material for ingestion.",
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

export function materialRoutes(
  database: Database,
  storage?: StorageService | null,
  redis?: RedisClient | null,
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

  // Audit declarations
  // Permission gates (QA-008). These routes used to have none -- they were exempted as "authorized
  // by signed upload URL and row ownership", but no ownership check existed, so any student or
  // parent able to read a class could rename, delete or AI-expose its materials. Reads need
  // material:read; each write needs its own permission, and the service then requires the caller
  // to lead the school or teach the material's class. Hono matches `:materialId` against "upload",
  // so the per-method guards keep each mount to the methods its own routes serve.
  routes.use(
    "/api/academics/materials",
    onlyMethods(["GET"], requirePermission(PERMISSIONS.MATERIAL_READ)),
  );
  routes.use(
    "/api/academics/materials/upload",
    onlyMethods(["POST"], requirePermission(PERMISSIONS.MATERIAL_CREATE)),
  );
  routes.use(
    "/api/academics/materials/:materialId",
    onlyMethods(["GET"], requirePermission(PERMISSIONS.MATERIAL_READ)),
  );
  routes.use(
    "/api/academics/materials/:materialId",
    onlyMethods(["PATCH"], requirePermission(PERMISSIONS.MATERIAL_UPDATE)),
  );
  routes.use(
    "/api/academics/materials/:materialId",
    onlyMethods(["DELETE"], requirePermission(PERMISSIONS.MATERIAL_DELETE)),
  );
  routes.use(
    "/api/academics/materials/:materialId/confirm",
    onlyMethods(["POST"], requirePermission(PERMISSIONS.MATERIAL_CREATE)),
  );
  routes.use(
    "/api/academics/materials/:materialId/ai-visible",
    onlyMethods(["PATCH"], requirePermission(PERMISSIONS.MATERIAL_MANAGE_AI)),
  );

  routes.use("/api/academics/materials/upload", auditAction("insert", "materials"));
  routes.use("/api/academics/materials/:materialId", auditAction("update", "materials"));
  routes.use("/api/academics/materials/:materialId/confirm", auditAction("update", "materials"));
  routes.use("/api/academics/materials/:materialId/ai-visible", auditAction("update", "materials"));

  routes.openapi(listMaterialsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listMaterials(tx, auth.schoolId, query),
    );

    return c.json({ materials: rows, total }, 200);
  });

  routes.openapi(getMaterialRoute, async (c) => {
    const auth = requireAuth(c);
    const { materialId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getMaterial(tx, auth.schoolId, materialId),
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

    // Claim-based quota pre-check before the row is created or a PUT is signed; confirm charges the
    // real stored size (QA-009), so this only spares an obviously over-quota upload its round trip.
    const result = await withTenantTx(database, tenantFrom(c), async (tx) => {
      await assertStorageUploadQuota(tx, body.size_bytes);
      return initiateUpload(tx, auth.schoolId, auth.userId, body);
    });

    const presigned = await storage.presign(result.storage_key, "PUT", body.mime_type);

    return c.json(
      {
        material_id: result.material.id,
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

    if (!storage) {
      throw new HTTPException(503, { message: "Storage not configured" });
    }

    // The staged pipeline (modules/storage/staged-promotion.ts), as every other upload uses
    // (QA-009): authorize, inspect the *stored* object with no transaction open, charge quota for
    // its real size, copy it to the material's own permanent key, record it, drop the temp copy.
    // The client only ever held a PUT URL for temp/, so nothing it writes later reaches what is
    // served.
    const existing = await withTenantTx(database, tenantFrom(c), (tx) =>
      beginConfirmUpload(tx, auth.schoolId, materialId, body.storage_key),
    );
    const inspected = await inspectStagedUpload(
      storage,
      auth.schoolId,
      getContentClass("material.file"),
      { storageKey: body.storage_key, checksumSha256: body.checksum_sha256 },
    );
    await withTenantTx(database, tenantFrom(c), (tx) => reserveStorage(tx, inspected.sizeBytes));
    const copy = {
      tempKey: body.storage_key,
      permanentKey: existing.storage_key,
      sizeBytes: inspected.sizeBytes,
    };
    await copyStagedUploads(storage, tenantTxRunner(database, tenantFrom(c)), [copy]);
    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      finishConfirmUpload(tx, auth.schoolId, existing, {
        sizeBytes: inspected.sizeBytes,
        contentType: inspected.contentType,
        checksumSha256: inspected.checksumSha256 ?? null,
      }),
    );
    await discardStagedUploads(storage, [copy]);

    // Hand the confirmed material to the file-scan worker. The status flip above is the claim: the
    // worker only touches materials still in 'scanning', so a retry (or a duplicate enqueue) can
    // never scan the same object twice or notify the uploader twice.
    if (scanQueue && row.ingest_status === "scanning") {
      await scanQueue.add(
        JOB_NAMES.SCAN_MATERIAL,
        {
          schoolId: auth.schoolId,
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
