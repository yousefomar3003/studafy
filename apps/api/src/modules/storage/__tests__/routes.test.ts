/**
 * Storage gateway route tests (SAD §22): auth precedence, per-content-class RBAC, and the
 * upload/confirm happy paths. Storage is faked; the service-level policy rules are covered in
 * service.test.ts, so this file concentrates on what the routes add: status codes and contract.
 */

// Imported before anything else — see the note in src/middleware/authz.test.ts.
import "@hono/zod-openapi";
import { PERMISSIONS, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createLogger } from "../../../logger";
import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { requestIdMiddleware } from "../../../middleware/requestId";
import { storageRoutes } from "../routes";

import type { ObjectMetadata, PresignedUrl, StorageService } from "../../../lib/storage";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { Role } from "@studafy/constants";

const SCHOOL_ID = "school-1";
const VALID_SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const silentLogger = createLogger({ destination: () => undefined });

function contextFor(roles: readonly Role[]): AuthContext {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    schoolId: SCHOOL_ID,
    roles,
    channel: "api",
    jti: "33333333-3333-4333-8333-333333333333",
    entitlementsVer: 1,
    subscriptionStatus: "active",
  };
}

function fakeStorage(seed: Record<string, number> = {}): StorageService {
  const objects = new Map<string, number>(Object.entries(seed));
  return {
    ttlSeconds: 900,
    presign(key): PresignedUrl {
      return {
        url: `https://storage.example/${key}?signed`,
        expiresAt: new Date(Date.now() + 900_000),
      };
    },
    async exists(key) {
      return objects.has(key);
    },
    async size(key) {
      return objects.get(key) ?? 0;
    },
    async head(key): Promise<ObjectMetadata | null> {
      return objects.has(key)
        ? { contentType: "application/pdf", sizeBytes: objects.get(key) ?? 0 }
        : null;
    },
    async checksumSha256() {
      return VALID_SHA;
    },
    async copy(source, destination) {
      objects.set(destination, objects.get(source) ?? 0);
    },
    async remove(key) {
      objects.delete(key);
    },
  };
}

function appWith(auth: AuthContext | undefined, storage: StorageService | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requestIdMiddleware({ logger: silentLogger }));
  app.use("*", async (c, next) => {
    if (auth) c.set("auth", auth);
    c.set("log", silentLogger);
    await next();
  });
  app.onError(errorHandlerMiddleware(silentLogger));
  app.route("/", storageRoutes(storage));
  return app;
}

const post = (path: string, body: unknown) => ({
  method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("storage routes", () => {
  test("request-upload answers 401 before anything else when unauthenticated", async () => {
    const app = appWith(undefined, fakeStorage());
    const res = await app.request(
      "/api/storage/uploads/request-upload",
      post("/api/storage/uploads/request-upload", {
        content_class: "assignment.attachment",
        file_name: "notes.pdf",
        content_type: "application/pdf",
        size_bytes: 2048,
      }),
    );
    expect(res.status).toBe(401);
  });

  test("both endpoints answer 503 when storage is not configured", async () => {
    const app = appWith(contextFor([ROLES.ORG_ADMIN]), null);
    const validBody = {
      content_class: "assignment.attachment",
      file_name: "notes.pdf",
      content_type: "application/pdf",
      size_bytes: 2048,
    };

    const upload = await app.request(
      "/api/storage/uploads/request-upload",
      post("/api/storage/uploads/request-upload", validBody),
    );
    expect(upload.status).toBe(503);

    const confirm = await app.request(
      "/api/storage/uploads/confirm",
      post("/api/storage/uploads/confirm", {
        content_class: "assignment.attachment",
        storage_key: "temp/school-1/object-1/notes.pdf",
      }),
    );
    expect(confirm.status).toBe(503);
  });

  test("request-upload is gated per content class by the class's permission", async () => {
    // material.file requires MATERIAL_CREATE, which STUDENT does not hold.
    const app = appWith(contextFor([ROLES.STUDENT]), fakeStorage());
    const res = await app.request(
      "/api/storage/uploads/request-upload",
      post("/api/storage/uploads/request-upload", {
        content_class: "material.file",
        file_name: "notes.pdf",
        content_type: "application/pdf",
        size_bytes: 2048,
      }),
    );
    expect(res.status).toBe(403);
  });

  test("request-upload returns a tenant-prefixed temp key to an authorized caller", async () => {
    // INSTRUCTOR holds MATERIAL_CREATE.
    const app = appWith(contextFor([ROLES.INSTRUCTOR]), fakeStorage());
    const res = await app.request(
      "/api/storage/uploads/request-upload",
      post("/api/storage/uploads/request-upload", {
        content_class: "material.file",
        file_name: "notes.pdf",
        content_type: "application/pdf",
        size_bytes: 2048,
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      upload_url: string;
      storage_key: string;
      expires_at: string;
    };
    expect(body.upload_url).toContain(body.storage_key);
    expect(body.expires_at).toBeTruthy();
    expect(body.storage_key.startsWith(`temp/${SCHOOL_ID}/`)).toBe(true);
  });

  test("request-upload rejects an unknown content class with 400", async () => {
    const app = appWith(contextFor([ROLES.ORG_ADMIN]), fakeStorage());
    const res = await app.request(
      "/api/storage/uploads/request-upload",
      post("/api/storage/uploads/request-upload", {
        content_class: "no.such.class",
        file_name: "notes.pdf",
        content_type: "application/pdf",
        size_bytes: 2048,
      }),
    );
    expect(res.status).toBe(400);
  });

  test("confirm uploads for an authorized class and reports the permanent key", async () => {
    const tempKey = "temp/school-1/object-1/notes.pdf";
    // STUDENT holds SUBMISSION_CREATE and may confirm under submission.attachment.
    const app = appWith(contextFor([ROLES.STUDENT]), fakeStorage({ [tempKey]: 2048 }));

    const res = await app.request(
      "/api/storage/uploads/confirm",
      post("/api/storage/uploads/confirm", {
        content_class: "submission.attachment",
        storage_key: tempKey,
        checksum_sha256: VALID_SHA,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      storage_key: string;
      original_file_name: string;
      content_type: string;
      size_bytes: number;
      checksum_sha256: string | null;
    };
    expect(body.storage_key).toBe(`permanent/${SCHOOL_ID}/object-1/notes.pdf`);
    expect(body.original_file_name).toBe("notes.pdf");
    expect(body.content_type).toBe("application/pdf");
    expect(body.size_bytes).toBe(2048);
    expect(body.checksum_sha256).toBe(VALID_SHA);
  });

  test("confirm rejects a foreign tenant's key with 403", async () => {
    const app = appWith(contextFor([ROLES.STUDENT]), fakeStorage());
    const res = await app.request(
      "/api/storage/uploads/confirm",
      post("/api/storage/uploads/confirm", {
        content_class: "submission.attachment",
        storage_key: "temp/other-school/object-1/notes.pdf",
      }),
    );
    expect(res.status).toBe(403);
  });

  test("permission constants stay in sync with the registry usage", () => {
    // A compile-time smoke test that the permission names the registry references exist; the
    // matrix test in authz.test.ts guarantees every PERMISSIONS entry is reachable by a role.
    expect(PERMISSIONS.MATERIAL_CREATE).toBe("material:create");
    expect(PERMISSIONS.SUBMISSION_CREATE).toBe("submission:create");
  });
});
