import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import {
  confirmUpload,
  deleteMaterial,
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
import type { AppEnv } from "../../../middleware/requestId";
import type { StorageClient } from "../material-service";
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
    [400, 401, 403, 404, 409, 500],
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
    "processing state. The ingestion worker picks it up from there.",
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
        description: "Material confirmed, now in processing state.",
        schema: materialSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
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
    "The storage object is not removed from the bucket.",
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
  storage?: StorageClient | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Audit declarations
  routes.use("/api/academics/materials/upload", auditAction("insert", "materials"));
  routes.use("/api/academics/materials/{materialId}", auditAction("update", "materials"));
  routes.use("/api/academics/materials/{materialId}/confirm", auditAction("update", "materials"));
  routes.use(
    "/api/academics/materials/{materialId}/ai-visible",
    auditAction("update", "materials"),
  );

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

    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      initiateUpload(tx, auth.schoolId, auth.userId, body),
    );

    const presigned = await storage.createPresignedUpload(result.storage_key, body.mime_type);

    return c.json(
      {
        upload_url: presigned.uploadUrl,
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

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      confirmUpload(tx, auth.schoolId, materialId, body.storage_key, body.checksum_sha256),
    );

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

    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteMaterial(tx, auth.schoolId, materialId),
    );

    return new Response(null, { status: 204 });
  });

  routes.openapi(toggleAiVisibleRoute, async (c) => {
    const auth = requireAuth(c);
    const { materialId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      toggleAiVisible(tx, auth.schoolId, materialId, body.ai_visible),
    );

    return c.json(row, 200);
  });

  return routes;
}
