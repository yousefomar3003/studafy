/**
 * Download gateway route and service tests (SAD §22): the read leg of the storage gateway.
 *
 * The route contract (404 when no database, 401/400/403/503) is exercised here with a dummy
 * database, because every one of those paths fails before the tenant transaction opens. The
 * tenant-scoped RLS resolution, the audit rows, and the presign TTL need a live PostgreSQL, and
 * live in downloads.integration.test.ts.
 */

// Imported before anything else — see the note in src/middleware/authz.test.ts.
import "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { CodedHttpException } from "../../../coded-http-exception";
import { createLogger } from "../../../logger";
import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { requestIdMiddleware } from "../../../middleware/requestId";
import { getDownloadClass } from "../content-classes";
import { DOWNLOAD_PRESIGN_TTL_SECONDS, requestDownload } from "../download-service";
import { storageRoutes } from "../routes";

import type { Database } from "../../../db/client";
import type { PresignedUrl, StorageService } from "../../../lib/storage";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

const SCHOOL_ID = "school-1";
const OBJECT_ID = "11111111-1111-4111-8111-111111111111";
const STORAGE_KEY = `permanent/${SCHOOL_ID}/object-1/notes.pdf`;

const silentLogger = createLogger({ destination: () => undefined });

/** Any object satisfies `if (database)`; the tested paths fail before withTenantTx opens. */
const dummyDatabase = {} as Database;

function contextFor(roles: readonly Role[]): AuthContext {
  return {
    userId: "22222222-2222-4222-8222-222222222222",
    schoolId: SCHOOL_ID,
    roles,
    channel: "api",
    jti: "33333333-3333-4333-8333-333333333333",
    entitlementsVer: 1,
    subscriptionStatus: "active",
  };
}

function fakeStorage(): StorageService & { presignCalls: { key: string; ttl?: number }[] } {
  const presignCalls: { key: string; ttl?: number }[] = [];
  const objects = new Map<string, number>();
  return {
    presignCalls,
    ttlSeconds: 900,
    presign(key, _method, _contentType, ttlOverrideSeconds): PresignedUrl {
      presignCalls.push({ key, ttl: ttlOverrideSeconds });
      return {
        url: `https://storage.example/${key}?signed`,
        expiresAt: new Date(Date.now() + (ttlOverrideSeconds ?? 900) * 1000),
      };
    },
    async exists(key) {
      return objects.has(key);
    },
    async size(key) {
      return objects.get(key) ?? 0;
    },
    async head(key) {
      return objects.has(key) ? { contentType: "application/pdf", sizeBytes: 1024 } : null;
    },
    async checksumSha256() {
      return "0".repeat(64);
    },
    async copy(source, destination) {
      objects.set(destination, objects.get(source) ?? 0);
    },
    async remove(key) {
      objects.delete(key);
    },
    async *list(prefix) {
      for (const [key, sizeBytes] of objects) {
        if (key.startsWith(prefix)) yield { key, sizeBytes };
      }
    },
  };
}

/**
 * A postgres.js-shaped transaction whose queries all return the given rows, recording the SQL of
 * every call so tests can assert on the side effects (the audit INSERT, or its absence).
 */
function fakeTx(rows: unknown[]): TransactionSql & { calls: string[] } {
  const calls: string[] = [];
  const txFn = (strings: TemplateStringsArray): Promise<unknown[]> => {
    calls.push(strings.join("?"));
    return Promise.resolve(rows);
  };
  Object.assign(txFn, {
    json: (value: unknown) => value,
    calls,
  });
  return txFn as unknown as TransactionSql & { calls: string[] };
}

function appWith(
  auth: AuthContext | undefined,
  storage: StorageService | null,
  database: Database | null,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requestIdMiddleware({ logger: silentLogger }));
  app.use("*", async (c, next) => {
    if (auth) c.set("auth", auth);
    c.set("log", silentLogger);
    await next();
  });
  app.onError(errorHandlerMiddleware(silentLogger));
  app.route("/", storageRoutes(storage, database));
  return app;
}

const get = (_path: string) => ({ method: "GET" as const });

// ---------------------------------------------------------------------------
// Route contract
// ---------------------------------------------------------------------------

describe("download route", () => {
  test("is not mounted without a database", async () => {
    const app = appWith(contextFor([ROLES.ORG_ADMIN]), fakeStorage(), null);
    const res = await app.request(
      `/api/storage/downloads/material/${OBJECT_ID}`,
      get(`/api/storage/downloads/material/${OBJECT_ID}`),
    );
    expect(res.status).toBe(404);
  });

  test("answers 401 before anything else when unauthenticated", async () => {
    const app = appWith(undefined, fakeStorage(), dummyDatabase);
    const res = await app.request(
      `/api/storage/downloads/material/${OBJECT_ID}`,
      get(`/api/storage/downloads/material/${OBJECT_ID}`),
    );
    expect(res.status).toBe(401);
  });

  test("rejects an unknown download class with 400", async () => {
    const app = appWith(contextFor([ROLES.ORG_ADMIN]), fakeStorage(), dummyDatabase);
    const res = await app.request(
      `/api/storage/downloads/bogus/${OBJECT_ID}`,
      get(`/api/storage/downloads/bogus/${OBJECT_ID}`),
    );
    expect(res.status).toBe(400);
  });

  test("rejects a malformed object id with 400", async () => {
    const app = appWith(contextFor([ROLES.ORG_ADMIN]), fakeStorage(), dummyDatabase);
    const res = await app.request(
      "/api/storage/downloads/material/not-a-uuid",
      get("/api/storage/downloads/material/not-a-uuid"),
    );
    expect(res.status).toBe(400);
  });

  test("answers 403 when the caller lacks the class permission", async () => {
    // GUEST holds neither MATERIAL_READ nor BILLING_READ.
    const app = appWith(contextFor([ROLES.GUEST]), fakeStorage(), dummyDatabase);
    const material = await app.request(
      `/api/storage/downloads/material/${OBJECT_ID}`,
      get(`/api/storage/downloads/material/${OBJECT_ID}`),
    );
    expect(material.status).toBe(403);

    const receipt = await app.request(
      `/api/storage/downloads/receipt/${OBJECT_ID}`,
      get(`/api/storage/downloads/receipt/${OBJECT_ID}`),
    );
    expect(receipt.status).toBe(403);
  });

  test("answers 503 when storage is not configured", async () => {
    const app = appWith(contextFor([ROLES.ORG_ADMIN]), null, dummyDatabase);
    const res = await app.request(
      `/api/storage/downloads/material/${OBJECT_ID}`,
      get(`/api/storage/downloads/material/${OBJECT_ID}`),
    );
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Download class registry
// ---------------------------------------------------------------------------

describe("download class registry", () => {
  test("lists the four single-word classes with their permission and audit policy", () => {
    expect(getDownloadClass("material").requiredPermissions).toEqual([PERMISSIONS.MATERIAL_READ]);
    expect(getDownloadClass("material").audit).toBe(false);

    expect(getDownloadClass("submission").requiredPermissions).toEqual([
      PERMISSIONS.SUBMISSION_READ,
    ]);
    expect(getDownloadClass("submission").audit).toBe(false);

    expect(getDownloadClass("receipt").requiredPermissions).toEqual([PERMISSIONS.BILLING_READ]);
    expect(getDownloadClass("receipt").audit).toBe(true);

    expect(getDownloadClass("export").requiredPermissions).toEqual([
      PERMISSIONS.ATTENDANCE_REPORT_EXPORT,
      PERMISSIONS.REPORT_EXPORT,
    ]);
    expect(getDownloadClass("export").audit).toBe(true);
  });

  test("rejects an unknown class with 400 VALIDATION_FAILED", () => {
    try {
      getDownloadClass("no.such.class");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CodedHttpException);
      expect((error as CodedHttpException).status).toBe(400);
      expect((error as CodedHttpException).code).toBe(ERROR_CODES.VALIDATION_FAILED);
    }
  });
});

// ---------------------------------------------------------------------------
// requestDownload service
// ---------------------------------------------------------------------------

describe("requestDownload", () => {
  test("mints a short-lived GET URL for the resolved object", async () => {
    const storage = fakeStorage();
    const result = await requestDownload(
      fakeTx([{ storage_key: STORAGE_KEY }]),
      storage,
      SCHOOL_ID,
      "material",
      OBJECT_ID,
    );

    expect(result.downloadUrl).toContain(STORAGE_KEY);
    expect(result.originalFileName).toBe("notes.pdf");
    expect(result.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + (DOWNLOAD_PRESIGN_TTL_SECONDS - 5) * 1000,
    );
    expect(result.expiresAt.getTime()).toBeLessThan(
      Date.now() + (DOWNLOAD_PRESIGN_TTL_SECONDS + 5) * 1000,
    );
    expect(storage.presignCalls).toEqual([{ key: STORAGE_KEY, ttl: DOWNLOAD_PRESIGN_TTL_SECONDS }]);
  });

  test("answers 404 for a missing or invisible object", async () => {
    const storage = fakeStorage();
    try {
      await requestDownload(fakeTx([]), storage, SCHOOL_ID, "material", OBJECT_ID);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CodedHttpException);
      expect((error as CodedHttpException).status).toBe(404);
      expect((error as CodedHttpException).code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    }
    expect(storage.presignCalls).toHaveLength(0);
  });

  test("audits receipt and export issuance, but not material", async () => {
    const row = [{ storage_key: STORAGE_KEY }];

    const materialTx = fakeTx(row);
    await requestDownload(materialTx, fakeStorage(), SCHOOL_ID, "material", OBJECT_ID);
    expect(materialTx.calls.some((sql) => sql.includes("INSERT INTO app.audit_logs"))).toBe(false);

    const receiptTx = fakeTx(row);
    await requestDownload(receiptTx, fakeStorage(), SCHOOL_ID, "receipt", OBJECT_ID);
    expect(receiptTx.calls.some((sql) => sql.includes("INSERT INTO app.audit_logs"))).toBe(true);

    const exportTx = fakeTx(row);
    await requestDownload(exportTx, fakeStorage(), SCHOOL_ID, "export", OBJECT_ID);
    expect(exportTx.calls.some((sql) => sql.includes("INSERT INTO app.audit_logs"))).toBe(true);
  });

  test("rejects an unknown class with 400 before touching storage", async () => {
    const storage = fakeStorage();
    try {
      await requestDownload(fakeTx([]), storage, SCHOOL_ID, "bogus" as never, OBJECT_ID);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CodedHttpException);
      expect((error as CodedHttpException).status).toBe(400);
    }
    expect(storage.presignCalls).toHaveLength(0);
  });
});
