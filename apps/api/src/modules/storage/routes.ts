import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { requireStorage } from "../../lib/storage";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermissionIn } from "../../middleware/authz";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import { getContentClass } from "./content-classes";
import {
  confirmedUploadSchema,
  confirmUploadBodySchema,
  requestUploadBodySchema,
  uploadUrlResponseSchema,
} from "./schemas";
import { confirmUpload, requestUpload } from "./service";

import type { StorageService } from "../../lib/storage";
import type { AppEnv } from "../../middleware/requestId";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const requestUploadRoute = createRoute({
  method: "post",
  path: "/api/storage/uploads/request-upload",
  tags: ["Storage"],
  operationId: "requestUpload",
  summary: "Request a pre-signed upload URL",
  description:
    "Step 1 of the generic upload flow. Validates the claimed type and size against the content " +
    "class and the caller's permissions, then returns a pre-signed PUT URL bound to a fresh " +
    "tenant-prefixed temp key. The client PUTs the file directly to that URL, then calls confirm.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: requestUploadBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "Pre-signed upload URL ready.",
        schema: uploadUrlResponseSchema,
      },
    },
    [400, 401, 403, 500, 503],
  ),
});

const confirmUploadRoute = createRoute({
  method: "post",
  path: "/api/storage/uploads/confirm",
  tags: ["Storage"],
  operationId: "confirmUpload",
  summary: "Confirm a staged upload",
  description:
    "Step 2 of the generic upload flow. Proves the object is really in the bucket, re-checks its " +
    "stored type and size against the content class, optionally verifies a client-supplied SHA-256, " +
    "then promotes the object from temp/ to permanent/ and returns the permanent key to persist.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: confirmUploadBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Upload confirmed and promoted to permanent storage.",
        schema: confirmedUploadSchema,
      },
    },
    [400, 401, 403, 404, 500, 503],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * The generic object-storage gateway.
 *
 * Authorization is per content class: the required permission lives in the body, so it cannot be
 * hoisted to a mount-time requirePermission() guard. Each handler resolves the class, then asserts
 * that class's permission via requirePermissionIn(). This is equivalent authorization exercised at
 * request time — the same reason discipline and evaluation routes gate per method.
 *
 * The auditAction declarations mirror the SES email webhook: they exist for the CI coverage gate
 * and name the intended mutation, but no app.audit_logs row is written because the staged object
 * in temp/ IS the audit record of the mutation — an infra-level event, not a database row.
 */
export function storageRoutes(storage: StorageService | null): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/storage/uploads/request-upload", auditAction("insert", "storage_objects"));
  routes.use("/api/storage/uploads/confirm", auditAction("update", "storage_objects"));

  routes.openapi(requestUploadRoute, async (c) => {
    const auth = requireAuth(c);
    const storageService = requireStorage(storage);
    const body = c.req.valid("json");
    const contentClass = getContentClass(body.content_class);
    requirePermissionIn(c, contentClass.requiredPermission);

    const { storageKey, presigned } = await requestUpload(
      storageService,
      auth.schoolId,
      contentClass,
      {
        fileName: body.file_name,
        contentType: body.content_type,
        sizeBytes: body.size_bytes,
      },
    );

    return c.json(
      {
        upload_url: presigned.url,
        storage_key: storageKey,
        expires_at: presigned.expiresAt.toISOString(),
      },
      201,
    );
  });

  routes.openapi(confirmUploadRoute, async (c) => {
    const auth = requireAuth(c);
    const storageService = requireStorage(storage);
    const body = c.req.valid("json");
    const contentClass = getContentClass(body.content_class);
    requirePermissionIn(c, contentClass.requiredPermission);

    const confirmed = await confirmUpload(storageService, auth.schoolId, contentClass, {
      storageKey: body.storage_key,
      checksumSha256: body.checksum_sha256,
    });

    return c.json(
      {
        storage_key: confirmed.storageKey,
        original_file_name: confirmed.originalFileName,
        content_type: confirmed.contentType,
        size_bytes: confirmed.sizeBytes,
        checksum_sha256: confirmed.checksumSha256,
      },
      200,
    );
  });

  return routes;
}
