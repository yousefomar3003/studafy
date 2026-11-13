import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { INGESTION_JOB_OPTIONS, JOB_NAMES, PERMISSIONS, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { onlyMethods } from "../../../middleware/only-methods";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { purgeMaterialAiCaches } from "../../ai/material-cache-purge";
import {
  getClassAiMaterialsSetting,
  setClassAiMaterialsSetting,
} from "../class-ai-materials-service";
import {
  classAiMaterialsSettingSchema,
  classIdParamSchema,
  updateClassAiMaterialsBodySchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getClassAiMaterialsRoute = createRoute({
  method: "get",
  path: "/api/academics/classes/{classId}/ai-materials",
  tags: ["Academics"],
  operationId: "getClassAiMaterials",
  summary: "Get the class's AI materials setting",
  description:
    "Whether this class's study materials are used with the AI study assistant. Readable by " +
    "anyone who can see the class.",
  security: [{ bearerAuth: [] }],
  request: { params: classIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The class's AI materials setting.",
        schema: classAiMaterialsSettingSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const updateClassAiMaterialsRoute = createRoute({
  method: "put",
  path: "/api/academics/classes/{classId}/ai-materials",
  tags: ["Academics"],
  operationId: "updateClassAiMaterials",
  summary: "Set the class's AI materials setting",
  description:
    "Turns using this class's study materials with the AI study assistant on or off. Requires " +
    "material:manageAi, and the caller must teach the class or lead the school. Turning it off " +
    "deletes the class's AI chunks (and everything generated from them) and stops new uploads " +
    "from being ingested; turning it on queues the class's AI-visible materials for ingestion.",
  security: [{ bearerAuth: [] }],
  request: {
    params: classIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateClassAiMaterialsBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The class's updated AI materials setting.",
        schema: classAiMaterialsSettingSchema,
      },
    },
    [400, 401, 403, 404, 500],
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

export function classAiMaterialsRoutes(
  database: Database,
  redis?: RedisClient | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // The ai-ingestion producer for turning the setting back on. Null when Redis is unavailable: the
  // materials are still re-staged to 'queued', the same degraded mode materialRoutes runs in.
  const ingestionQueue = redis
    ? new Queue(QUEUE_NAMES.AI_INGESTION, { connection: redis as never })
    : null;

  // Writes need material:manageAi (teachers, principal, school admin); the service then narrows a
  // teacher to the classes they teach. Reads stay open to whoever can see the class, scoped by RLS.
  const manage = requirePermission(PERMISSIONS.MATERIAL_MANAGE_AI);
  routes.use("/api/academics/classes/:classId/ai-materials", onlyMethods(["PUT"], manage));
  routes.use("/api/academics/classes/:classId/ai-materials", auditAction("update", "classes"));

  routes.openapi(getClassAiMaterialsRoute, async (c) => {
    const auth = requireAuth(c);
    const { classId } = c.req.valid("param");

    const setting = await withTenantTx(database, tenantFrom(c), (tx) =>
      getClassAiMaterialsSetting(tx, auth.schoolId, classId),
    );
    if (!setting) {
      throw new HTTPException(404, { message: "Class not found" });
    }

    return c.json(setting, 200);
  });

  routes.openapi(updateClassAiMaterialsRoute, async (c) => {
    const auth = requireAuth(c);
    const { classId } = c.req.valid("param");
    const body = c.req.valid("json");

    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      setClassAiMaterialsSetting(tx, auth.schoolId, classId, body.enabled),
    );

    // After the commit: the ingestion worker's claim on 'queued' makes a duplicate enqueue a no-op.
    if (ingestionQueue && result.requeuedMaterialIds.length > 0) {
      await ingestionQueue.addBulk(
        result.requeuedMaterialIds.map((materialId) => ({
          name: JOB_NAMES.INGEST_MATERIAL,
          data: { version: 1, schoolId: auth.schoolId, materialId },
          opts: INGESTION_JOB_OPTIONS,
        })),
      );
    }

    // Cached summaries/key concepts are already unreachable (every read path refuses the material);
    // removing them is hygiene, so a Redis hiccup must not fail the committed change.
    if (redis && result.classMaterialIds.length > 0) {
      await purgeMaterialAiCaches(redis, result.classMaterialIds).catch((err: unknown) => {
        c.get("log")?.warn(
          { err, school_id: auth.schoolId, class_id: classId },
          "AI material cache purge failed",
        );
      });
    }

    return c.json(result.setting, 200);
  });

  return routes;
}
