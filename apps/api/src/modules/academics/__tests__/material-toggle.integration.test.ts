/**
 * ST-161 ingestion orchestration — the AI re-enable / re-ingest staging flip (`toggleAiVisible`).
 *
 * The route contract is covered by the route's openapi layer; what needs a live PostgreSQL is the
 * guarded status transition itself: 'ready' -> 'queued' (clearing the ingest stamp to satisfy the
 * lifecycle CHECK), every other state left alone so nothing mid-flight is derailed, 'failed' never
 * silently re-ingested, disable resetting to 'uploaded' and purging chunks, and the tenant-scope
 * boundary rejecting a foreign school.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/academics/__tests__/material-toggle.integration.test.ts
 */

import { ERROR_CODES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  createFullTenant,
  createMaterial,
  createSchool,
  createTeacher,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  type TenantFixture,
  type TestDatabase,
} from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { toggleAiVisible } from "../material-service";

import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
/**
 * Dedicated single-connection clients for the two transaction kinds (see note below): admin
 * seeding (studafy_admin) and tenant transactions (studafy_app under RLS) never share a
 * connection, because a back-to-back `begin` on one bun 1.3.14 postgres.js connection can hang.
 */
let adminClient: ReturnType<typeof postgres> | undefined;
let tenantClient: ReturnType<typeof postgres> | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  // bun 1.3.14 + postgres.js: a pooled `sql.begin` issued after seeding can hang (server idle, the
  // connection is never drained) -- the same environment note as downloads.integration.test.ts.
  // Routing every BEGIN through pinned single connections (and splitting admin from tenant work)
  // avoids it.
  adminClient = postgres(db.url, { max: 1, prepare: false });
  tenantClient = postgres(db.url, { max: 1, prepare: false });
});

afterAll(async () => {
  if (tenantClient) await tenantClient.end({ timeout: 1 });
  if (adminClient) await adminClient.end({ timeout: 1 });
  if (db?.cleanup) await db.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed a scoped row the way the fixtures do: school GUC first, then studafy_admin. */
async function asAdmin<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await adminClient!.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    result = await fn(tx);
  });
  return result as T;
}

/** Run the service the way production does: a tenant-scoped transaction as studafy_app under RLS. */
async function toggleAsTenant(
  tenant: TenantFixture,
  materialId: string,
  aiVisible: boolean,
): Promise<ReturnType<typeof toggleAiVisible>> {
  // can_read_class resolves through the lead teacher, so act as the class's teacher (not the
  // role-loop INSTRUCTOR user, who teaches no class) -- same convention as the downloads suite.
  return withTenantTx(
    tenantClient!,
    { schoolId: tenant.schoolId, userId: tenant.teachers[0]!.userId },
    (tx) => toggleAiVisible(tx, tenant.schoolId, materialId, aiVisible),
  );
}

interface SeedMaterial {
  materialId: string;
}

/** Create a material and force its ingest state (used to place it at each lifecycle point). */
async function seedMaterial(
  tenant: TenantFixture,
  ingestStatus: string,
  aiVisible = false,
): Promise<SeedMaterial> {
  const material = await createMaterial(db.sql, tenant.schoolId, {
    classId: tenant.cls.id,
    uploadedByUserId: tenant.teachers[0]!.userId,
  });
  const ingestError = ingestStatus === "failed" || ingestStatus === "quarantined" ? "boom" : null;
  const ingestedAt = ingestStatus === "ready" ? new Date("2026-01-01T00:00:00Z") : null;
  await asAdmin(tenant.schoolId, async (tx) => {
    await tx`
      UPDATE app.materials
      SET ai_visible = ${aiVisible},
          ingest_status = ${ingestStatus}::app.material_ingest_status,
          ingest_error = ${ingestError},
          ingested_at = ${ingestedAt}
      WHERE id = ${material.id}
    `;
  });
  return { materialId: material.id };
}

async function readMaterial(
  tenant: TenantFixture,
  materialId: string,
): Promise<{
  ai_visible: boolean;
  ingest_status: string;
  ingest_error: string | null;
  ingested_at: Date | null;
}> {
  const [row] = await db.sql<
    {
      ai_visible: boolean;
      ingest_status: string;
      ingest_error: string | null;
      ingested_at: Date | null;
    }[]
  >`
    SELECT ai_visible, ingest_status::text AS ingest_status, ingest_error, ingested_at
      FROM app.materials
     WHERE id = ${materialId} AND school_id = ${tenant.schoolId}
  `;
  return row!;
}

async function countChunks(tenant: TenantFixture, materialId: string): Promise<number> {
  const [row] = await db.sql<{ count: number }[]>`
    SELECT count(*)::int AS count
      FROM app.material_chunks
     WHERE material_id = ${materialId} AND school_id = ${tenant.schoolId}
  `;
  return row!.count;
}

// ---------------------------------------------------------------------------
// Enable: 'ready' is staged as 'queued'
// ---------------------------------------------------------------------------

describeDb("toggleAiVisible — enabling a ready material", () => {
  test("flips ready -> queued and clears the ingest stamp", async () => {
    const tenant = await createFullTenant(db.sql);
    const { materialId } = await seedMaterial(tenant, "ready");

    const row = await toggleAsTenant(tenant, materialId, true);

    expect(row.ai_visible).toBe(true);
    expect(row.ingest_status).toBe("queued");
    expect(row.ingest_error).toBeNull();
    expect(row.ingested_at).toBeNull();

    const persisted = await readMaterial(tenant, materialId);
    expect(persisted.ai_visible).toBe(true);
    expect(persisted.ingest_status).toBe("queued");
    expect(persisted.ingest_error).toBeNull();
    expect(persisted.ingested_at).toBeNull();
  });

  test("leaves a scanning material mid-flight untouched", async () => {
    const tenant = await createFullTenant(db.sql);
    const { materialId } = await seedMaterial(tenant, "scanning");

    const row = await toggleAsTenant(tenant, materialId, true);

    expect(row.ingest_status).toBe("scanning");
    const persisted = await readMaterial(tenant, materialId);
    expect(persisted.ingest_status).toBe("scanning");
    expect(persisted.ingested_at).toBeNull();
  });

  test("leaves a processing material mid-flight untouched", async () => {
    const tenant = await createFullTenant(db.sql);
    const { materialId } = await seedMaterial(tenant, "processing");

    const row = await toggleAsTenant(tenant, materialId, true);

    expect(row.ingest_status).toBe("processing");
  });

  test("does not silently re-ingest a failed material", async () => {
    const tenant = await createFullTenant(db.sql);
    const { materialId } = await seedMaterial(tenant, "failed");

    const row = await toggleAsTenant(tenant, materialId, true);

    expect(row.ai_visible).toBe(true);
    expect(row.ingest_status).toBe("failed");
    expect(row.ingest_error).toBe("boom");
    expect(row.ingested_at).toBeNull();
  });

  test("leaves an already-queued material queued (route dedups via the worker's claim)", async () => {
    const tenant = await createFullTenant(db.sql);
    const { materialId } = await seedMaterial(tenant, "queued");

    const row = await toggleAsTenant(tenant, materialId, true);

    expect(row.ingest_status).toBe("queued");
  });

  test("is a no-op when ai_visible is already true", async () => {
    const tenant = await createFullTenant(db.sql);
    const { materialId } = await seedMaterial(tenant, "ready");

    await toggleAsTenant(tenant, materialId, true);
    const afterFirst = await readMaterial(tenant, materialId);
    expect(afterFirst.ingest_status).toBe("queued");

    const again = await toggleAsTenant(tenant, materialId, true);
    expect(again.ingest_status).toBe("queued");
  });
});

// ---------------------------------------------------------------------------
// Disable: reset to 'uploaded' and purge chunks
// ---------------------------------------------------------------------------

describeDb("toggleAiVisible — disabling", () => {
  test("resets a ready material to uploaded, clears the stamp, and purges chunks", async () => {
    const tenant = await createFullTenant(db.sql);
    const { materialId } = await seedMaterial(tenant, "ready", true);

    await asAdmin(tenant.schoolId, async (tx) => {
      await tx`
        INSERT INTO app.material_chunks
          (school_id, material_id, chunk_index, content, embedding, embedding_model)
        VALUES
          (${tenant.schoolId}, ${materialId}, 0, 'chunk',
           array_fill(0::real, ARRAY[1536])::public.vector, 'test')
      `;
    });
    expect(await countChunks(tenant, materialId)).toBe(1);

    const row = await toggleAsTenant(tenant, materialId, false);

    expect(row.ai_visible).toBe(false);
    expect(row.ingest_status).toBe("uploaded");
    expect(row.ingest_error).toBeNull();
    expect(row.ingested_at).toBeNull();
    expect(await countChunks(tenant, materialId)).toBe(0);
  });

  test("is a no-op when ai_visible is already false", async () => {
    const tenant = await createFullTenant(db.sql);
    const { materialId } = await seedMaterial(tenant, "uploaded");

    const row = await toggleAsTenant(tenant, materialId, false);

    expect(row.ai_visible).toBe(false);
    expect(row.ingest_status).toBe("uploaded");
  });
});

// ---------------------------------------------------------------------------
// Scope and errors
// ---------------------------------------------------------------------------

describeDb("toggleAiVisible — scope and errors", () => {
  test("throws a coded 404 for an unknown material", async () => {
    const tenant = await createFullTenant(db.sql);

    // Capture one rejection so both assertions share a single tenant transaction.
    const pending = toggleAsTenant(tenant, crypto.randomUUID(), true);
    await expect(pending).rejects.toThrow(CodedHttpException);
    await expect(pending).rejects.toMatchObject({
      status: 404,
      code: ERROR_CODES.MATERIAL_NOT_FOUND,
    });
  }, 20_000);

  test("cannot see another school's material (tenant-scope boundary)", async () => {
    const tenantA = await createFullTenant(db.sql);
    const otherSchool = await createSchool(db.sql);
    const otherTeacher = await createTeacher(db.sql, otherSchool.id);
    const { materialId } = await seedMaterial(tenantA, "ready");

    await expect(
      withTenantTx(tenantClient!, { schoolId: otherSchool.id, userId: otherTeacher.userId }, (tx) =>
        toggleAiVisible(tx, otherSchool.id, materialId, true),
      ),
    ).rejects.toMatchObject({
      status: 404,
      code: ERROR_CODES.MATERIAL_NOT_FOUND,
    });
  }, 20_000);
});
