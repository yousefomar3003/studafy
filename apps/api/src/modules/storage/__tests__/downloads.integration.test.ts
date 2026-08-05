/**
 * Download gateway integration tests (SAD §22): the RLS row-scope boundary behind the download
 * leg of the storage gateway.
 *
 * Object storage is faked; what needs a live PostgreSQL is the tenant-scoped resolution itself,
 * and the audit rows it writes. Route contract and RBAC are covered in downloads.test.ts.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/storage/__tests__
 *
 * Known environment note: on bun 1.3.14 a pooled `sql.begin` issued after seeding can hang
 * (server idle, postgres.js never drains) -- this also affects pre-existing integration tests.
 * Run on a healthy runtime/CI; the tests are skipped without TEST_DATABASE_URL.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createClass,
  createEnrollment,
  createFullTenant,
  createMaterial,
  createStudent,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  type TenantFixture,
  type TestDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import { DOWNLOAD_PRESIGN_TTL_SECONDS, requestDownload } from "../download-service";

import type { PresignedUrl, StorageService } from "../../../lib/storage";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
});

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PresignCall {
  key: string;
  method: "GET" | "PUT";
  contentType?: string;
  ttl?: number;
}

function fakeStorage(): StorageService & {
  presignCalls: PresignCall[];
  objects: Map<string, number>;
} {
  const presignCalls: PresignCall[] = [];
  const objects = new Map<string, number>();
  const base: StorageService = {
    ttlSeconds: 900,
    presign(key, method, contentType, ttlOverrideSeconds): PresignedUrl {
      presignCalls.push({ key, method, contentType, ttl: ttlOverrideSeconds });
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
  };
  return Object.assign(base, { presignCalls, objects });
}

/** Seed a scoped row the way the fixtures do: school GUC first, then studafy_admin. */
async function asAdmin<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    result = await fn(tx);
  });
  return result as T;
}

/** Run code the way production does: a tenant-scoped transaction as studafy_app under RLS. */
async function asTenant<T>(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return withTenantTx(db.sql, { schoolId, userId }, fn);
}

/** Create a material and move it to the 'ready' ingest state (scan passed). */
async function seedReadyMaterial(
  tenant: TenantFixture,
  overrides?: { classId?: string; storageKey?: string },
): Promise<{ materialId: string; storageKey: string }> {
  const storageKey =
    overrides?.storageKey ?? `permanent/${tenant.schoolId}/materials/${crypto.randomUUID()}.pdf`;
  const material = await createMaterial(db.sql, tenant.schoolId, {
    classId: overrides?.classId ?? tenant.cls.id,
    uploadedByUserId: tenant.users.INSTRUCTOR.id,
    storageKey,
  });
  await asAdmin(tenant.schoolId, async (tx) => {
    await tx`
      UPDATE app.materials
      SET ingest_status = 'ready', ingest_error = NULL, ingested_at = CURRENT_TIMESTAMP
      WHERE id = ${material.id}
    `;
  });
  return { materialId: material.id, storageKey };
}

/** A submitted submission with one attachment owned by the tenant's primary student. */
async function seedSubmissionAttachment(tenant: TenantFixture): Promise<{
  attachmentId: string;
  storageKey: string;
}> {
  const storageKey = `permanent/${tenant.schoolId}/submissions/${crypto.randomUUID()}.pdf`;
  return asAdmin(tenant.schoolId, async (tx) => {
    const [assignment] = await tx<{ id: string }[]>`
      INSERT INTO app.assignments (
        school_id, class_id, created_by_user_id, last_edited_by_user_id,
        title, status, assigned_at, due_at, max_score, allow_late_submission
      ) VALUES (
        ${tenant.schoolId}, ${tenant.cls.id}, ${tenant.users.INSTRUCTOR.id}, ${tenant.users.INSTRUCTOR.id},
        'Essay', 'published', CURRENT_TIMESTAMP - interval '1 day',
        CURRENT_TIMESTAMP + interval '7 days', 100, true
      )
      RETURNING id
    `;
    const student = tenant.students[0]!;
    const [submission] = await tx<{ id: string }[]>`
      INSERT INTO app.assignment_submissions (
        school_id, assignment_id, student_id, last_edited_by_user_id, status, submitted_at
      ) VALUES (
        ${tenant.schoolId}, ${assignment!.id}, ${student.id}, ${student.userId},
        'submitted', CURRENT_TIMESTAMP
      )
      RETURNING id
    `;
    const [attachment] = await tx<{ id: string }[]>`
      INSERT INTO app.submission_attachments (
        school_id, submission_id, uploaded_by_user_id,
        storage_key, original_file_name, mime_type, size_bytes
      ) VALUES (
        ${tenant.schoolId}, ${submission!.id}, ${student.userId},
        ${storageKey}, 'essay.pdf', 'application/pdf', 1024
      )
      RETURNING id
    `;
    return { attachmentId: attachment!.id, storageKey };
  });
}

/** A finance expense cache row with an attachment (the receipt class). */
async function seedReceipt(
  tenant: TenantFixture,
): Promise<{ receiptId: string; storageKey: string }> {
  const storageKey = `permanent/${tenant.schoolId}/receipts/${crypto.randomUUID()}.pdf`;
  return asAdmin(tenant.schoolId, async (tx) => {
    const [currency] = await tx<{ id: string }[]>`
      SELECT id FROM app.currencies WHERE code = 'USD' LIMIT 1
    `;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.expense_cache (
        school_id, document_type, category, vendor, currency_id,
        amount_minor, erpnext_docname, erpnext_status, attachment_storage_key, last_synced_at
      ) VALUES (
        ${tenant.schoolId}, 'purchase_invoice', 'supplies', 'Acme', ${currency!.id},
        5000, 'ACC-001', 'Submitted', ${storageKey}, CURRENT_TIMESTAMP
      )
      RETURNING id
    `;
    return { receiptId: row!.id, storageKey };
  });
}

/** A completed attendance export job (canonical reports/ key). */
async function seedAttendanceExport(
  tenant: TenantFixture,
): Promise<{ jobId: string; storageKey: string }> {
  const storageKey = `reports/${tenant.schoolId}/attendance-summary.xlsx`;
  return asAdmin(tenant.schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.report_export_jobs (
        school_id, requested_by_user_id, file_format, status, storage_key, completed_at
      ) VALUES (
        ${tenant.schoolId}, ${tenant.users.ORG_ADMIN.id}, 'xlsx', 'completed',
        ${storageKey}, CURRENT_TIMESTAMP
      )
      RETURNING id
    `;
    return { jobId: row!.id, storageKey };
  });
}

/**
 * A completed finance report job. Its object_key uses the legacy `tenant-<schoolId>/reports/...`
 * shape that predates the canonical four-segment scheme -- the load-bearing case for signing the
 * resolved key as-is rather than assertSchoolOwnedKey.
 */
async function seedFinanceExport(
  tenant: TenantFixture,
): Promise<{ jobId: string; storageKey: string }> {
  const storageKey = `tenant-${tenant.schoolId}/reports/ar-aging.csv`;
  return asAdmin(tenant.schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.finance_report_jobs (
        school_id, requested_by_user_id, report_type, file_format, status,
        object_key, signed_url, signed_url_expires_at, completed_at
      ) VALUES (
        ${tenant.schoolId}, ${tenant.users.ORG_ADMIN.id}, 'ar_aging', 'csv', 'completed',
        ${storageKey}, 'https://signed.example/ar-aging.csv',
        CURRENT_TIMESTAMP + interval '1 day', CURRENT_TIMESTAMP
      )
      RETURNING id
    `;
    return { jobId: row!.id, storageKey };
  });
}

// ---------------------------------------------------------------------------
// Row scope
// ---------------------------------------------------------------------------

describeDb("download gateway row scope", () => {
  test("a teacher can download a scanned-ready material in a class they teach", async () => {
    const tenant = await createFullTenant(db.sql);
    const { materialId, storageKey } = await seedReadyMaterial(tenant, {
      storageKey: `permanent/${tenant.schoolId}/materials/notes.pdf`,
    });
    const storage = fakeStorage();

    // can_read_class resolves through the lead teacher, so act as the class's teacher (not the
    // role-loop INSTRUCTOR user, who teaches no class).
    const result = await asTenant(tenant.schoolId, tenant.teachers[0]!.userId, (tx) =>
      requestDownload(tx, storage, tenant.schoolId, "material", materialId),
    );

    expect(result.downloadUrl).toContain(storageKey);
    expect(result.originalFileName).toBe("notes.pdf");
    expect(result.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + (DOWNLOAD_PRESIGN_TTL_SECONDS - 5) * 1000,
    );
    expect(result.expiresAt.getTime()).toBeLessThan(
      Date.now() + (DOWNLOAD_PRESIGN_TTL_SECONDS + 5) * 1000,
    );
    expect(storage.presignCalls).toEqual([
      { key: storageKey, method: "GET", contentType: undefined, ttl: DOWNLOAD_PRESIGN_TTL_SECONDS },
    ]);

    // Material downloads are not audited.
    const audits = await db.sql`
      SELECT action FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId} AND target_id = ${materialId}
    `;
    expect(audits).toHaveLength(0);
  });

  test("a student cannot download a material in a class they are not in", async () => {
    const tenant = await createFullTenant(db.sql);
    const otherClass = await createClass(db.sql, tenant.schoolId, {
      courseId: tenant.course.id,
      academicYearId: tenant.academicYear.id,
      termId: tenant.term.id,
      leadTeacherId: tenant.teachers[0]!.id,
      roomId: tenant.room.id,
      code: `CLS2-${tenant.schoolSlug}`,
    });
    const { materialId } = await seedReadyMaterial(tenant, { classId: otherClass.id });
    const storage = fakeStorage();

    await expect(
      asTenant(tenant.schoolId, tenant.students[0]!.userId, (tx) =>
        requestDownload(tx, storage, tenant.schoolId, "material", materialId),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(storage.presignCalls).toHaveLength(0);
  });

  test("a material that is not scanned-ready answers 404", async () => {
    const tenant = await createFullTenant(db.sql);
    const { materialId } = await seedReadyMaterial(tenant);
    await asAdmin(tenant.schoolId, async (tx) => {
      await tx`
        UPDATE app.materials
        SET ingest_status = 'scanning', ingest_error = NULL, ingested_at = NULL
        WHERE id = ${materialId}
      `;
    });
    const storage = fakeStorage();

    await expect(
      asTenant(tenant.schoolId, tenant.users.INSTRUCTOR.id, (tx) =>
        requestDownload(tx, storage, tenant.schoolId, "material", materialId),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(storage.presignCalls).toHaveLength(0);
  });

  test("the owning student can download their submission file, a classmate cannot", async () => {
    const tenant = await createFullTenant(db.sql);
    const { attachmentId, storageKey } = await seedSubmissionAttachment(tenant);
    const classmate = await createStudent(db.sql, tenant.schoolId);
    await createEnrollment(db.sql, tenant.schoolId, tenant.cls.id, classmate.id);
    const storage = fakeStorage();

    const owned = await asTenant(tenant.schoolId, tenant.students[0]!.userId, (tx) =>
      requestDownload(tx, storage, tenant.schoolId, "submission", attachmentId),
    );
    expect(owned.downloadUrl).toContain(storageKey);

    // The classmate holds submission:read but role_scope_visibility keeps the row invisible:
    // 404, not 403, so the response cannot be used to probe which attachment ids exist.
    await expect(
      asTenant(tenant.schoolId, classmate.userId, (tx) =>
        requestDownload(tx, storage, tenant.schoolId, "submission", attachmentId),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// Audit and export resolution
// ---------------------------------------------------------------------------

describeDb("download gateway audit and export resolution", () => {
  test("a receipt download is audited with the export action", async () => {
    const tenant = await createFullTenant(db.sql);
    const { receiptId, storageKey } = await seedReceipt(tenant);
    const storage = fakeStorage();

    const result = await asTenant(tenant.schoolId, tenant.users.ORG_ADMIN.id, (tx) =>
      requestDownload(tx, storage, tenant.schoolId, "receipt", receiptId),
    );
    expect(result.downloadUrl).toContain(storageKey);

    const audits = await db.sql`
      SELECT action, target_table, new_values
      FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId} AND target_id = ${receiptId}
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("export");
    expect(audits[0].target_table).toBe("expense_cache");
    expect(audits[0].new_values).toMatchObject({ content_class: "receipt" });
  });

  test("an attendance export job resolves with its canonical key", async () => {
    const tenant = await createFullTenant(db.sql);
    const { jobId, storageKey } = await seedAttendanceExport(tenant);
    const storage = fakeStorage();

    const result = await asTenant(tenant.schoolId, tenant.users.ORG_ADMIN.id, (tx) =>
      requestDownload(tx, storage, tenant.schoolId, "export", jobId),
    );
    expect(result.downloadUrl).toContain(storageKey);
    expect(result.originalFileName).toBe("attendance-summary.xlsx");

    const audits = await db.sql`
      SELECT action, target_table FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId} AND target_id = ${jobId}
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("export");
    expect(audits[0].target_table).toBe("report_export_jobs");
  });

  test("a finance export job resolves with its legacy tenant-<schoolId> key, signed as-is", async () => {
    const tenant = await createFullTenant(db.sql);
    const { jobId, storageKey } = await seedFinanceExport(tenant);
    const storage = fakeStorage();

    const result = await asTenant(tenant.schoolId, tenant.users.ORG_ADMIN.id, (tx) =>
      requestDownload(tx, storage, tenant.schoolId, "export", jobId),
    );
    expect(result.downloadUrl).toContain(storageKey);
    expect(storage.presignCalls[0]!.key).toBe(storageKey);

    const audits = await db.sql`
      SELECT target_table FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId} AND target_id = ${jobId}
    `;
    expect(audits[0]!.target_table).toBe("finance_report_jobs");
  });
});

// ---------------------------------------------------------------------------
// Tenant boundary and probing
// ---------------------------------------------------------------------------

describeDb("download gateway tenant boundary", () => {
  test("another school cannot resolve a material it cannot see", async () => {
    const tenantA = await createFullTenant(db.sql);
    const tenantB = await createFullTenant(db.sql);
    const { materialId } = await seedReadyMaterial(tenantA);
    const storage = fakeStorage();

    await expect(
      asTenant(tenantB.schoolId, tenantB.users.INSTRUCTOR.id, (tx) =>
        requestDownload(tx, storage, tenantB.schoolId, "material", materialId),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(storage.presignCalls).toHaveLength(0);
  });

  test("an id that exists in no table answers 404 without minting a URL", async () => {
    const tenant = await createFullTenant(db.sql);
    const storage = fakeStorage();

    await expect(
      asTenant(tenant.schoolId, tenant.users.ORG_ADMIN.id, (tx) =>
        requestDownload(tx, storage, tenant.schoolId, "receipt", crypto.randomUUID()),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(storage.presignCalls).toHaveLength(0);
  });
});
