import {
  queryAttendanceSummary,
  queryAttendanceTrends,
  resolveReportFilter,
} from "@studafy/attendance-reporting";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createFullTenant,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import {
  createReportExportJob,
  failReportExportJob,
  getReportExportJob,
} from "../reports/report-service";

import type { TestDatabase, TenantFixture } from "../../../../tests/harness";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase;
let fixture: TenantFixture;
const year = new Date().getUTCFullYear();

async function asAdmin<T>(
  schoolId: string,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let value: T | undefined;
  await database.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    value = await callback(tx);
  });
  return value as T;
}

async function seedRecord(
  date: string,
  sessionStatus: "draft" | "open" | "submitted" | "locked" | "cancelled",
  attendanceStatus: "present" | "remote" | "absent" | "late" | "excused",
  period: number,
): Promise<string> {
  return asAdmin(fixture.schoolId, async (tx) => {
    const [session] = await tx<{ id: string; created_at: Date }[]>`
      INSERT INTO app.attendance_sessions
        (school_id, class_id, session_date, period, status, taken_by_user_id)
      VALUES (
        ${fixture.schoolId}, ${fixture.cls.id}, ${date}::date, ${period},
        ${sessionStatus}::app.attendance_session_status, ${fixture.teachers[0]!.userId}
      )
      RETURNING id, created_at
    `;
    const [record] = await tx<{ id: string }[]>`
      INSERT INTO app.attendance_records
        (school_id, attendance_session_id, session_created_at, student_id, status,
         minutes_late, recorded_by_user_id)
      VALUES (
        ${fixture.schoolId}, ${session!.id}, ${session!.created_at},
        ${fixture.students[0]!.id}, ${attendanceStatus}::app.attendance_status,
        ${attendanceStatus === "late" ? 5 : null}, ${fixture.teachers[0]!.userId}
      )
      RETURNING id
    `;
    return record!.id;
  });
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  fixture = await createFullTenant(database.sql);

  await seedRecord(`${year}-01-06`, "submitted", "present", 1);
  await seedRecord(`${year}-01-07`, "locked", "remote", 1);
  await seedRecord(`${year}-01-08`, "submitted", "absent", 1);
  await seedRecord(`${year}-01-09`, "submitted", "late", 1);
  await seedRecord(`${year}-01-10`, "locked", "excused", 1);
  const corrected = await seedRecord(`${year}-01-11`, "submitted", "absent", 1);
  await seedRecord(`${year}-01-12`, "open", "absent", 1);
  await seedRecord(`${year}-01-13`, "draft", "absent", 1);
  await seedRecord(`${year}-01-14`, "cancelled", "absent", 1);

  await asAdmin(fixture.schoolId, async (tx) => {
    await tx`
      UPDATE app.attendance_records
      SET status = 'present', updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${fixture.schoolId} AND id = ${corrected}
    `;
  });
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

describeDb("attendance report aggregation", () => {
  test("folds remote into present, uses current corrections, rounds, and excludes unfinished sessions", async () => {
    const result = await withTenantTx(
      database.sql,
      {
        schoolId: fixture.schoolId,
        userId: fixture.users.ORG_ADMIN.id,
      },
      async (tx) => {
        const filter = await resolveReportFilter(tx, fixture.schoolId, {
          startDate: `${year}-01-01`,
          endDate: `${year}-01-31`,
        });
        return queryAttendanceSummary(tx, fixture.schoolId, filter, "class", {
          limit: 100,
          offset: 0,
        });
      },
    );

    expect(result.total_groups).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.totals).toEqual({
      total_records: 6,
      present_count: 3,
      absent_count: 1,
      late_count: 1,
      excused_count: 1,
      present_percent: 50,
      absent_percent: 16.67,
      late_percent: 16.67,
      excused_percent: 16.67,
    });
  });

  test("resolves term metadata and returns only populated deterministic buckets", async () => {
    const result = await withTenantTx(
      database.sql,
      {
        schoolId: fixture.schoolId,
        userId: fixture.users.ORG_ADMIN.id,
      },
      async (tx) => {
        const filter = await resolveReportFilter(tx, fixture.schoolId, {
          termId: fixture.term.id,
          classId: fixture.cls.id,
          studentId: fixture.students[0]!.id,
        });
        const trends = await queryAttendanceTrends(tx, fixture.schoolId, filter, "day");
        return { filter, trends };
      },
    );

    expect(result.filter.termId).toBe(fixture.term.id);
    expect(result.filter.startDate).toBe(`${year}-01-01`);
    expect(result.filter.endDate).toBe(`${year}-06-30`);
    expect(result.trends.map((point) => point.bucket_start)).toEqual([
      `${year}-01-06`,
      `${year}-01-07`,
      `${year}-01-08`,
      `${year}-01-09`,
      `${year}-01-10`,
      `${year}-01-11`,
    ]);
  });

  test("returns zero totals and pagination metadata for an empty range", async () => {
    const result = await withTenantTx(
      database.sql,
      {
        schoolId: fixture.schoolId,
        userId: fixture.users.ORG_ADMIN.id,
      },
      async (tx) => {
        const filter = await resolveReportFilter(tx, fixture.schoolId, {
          startDate: `${year}-12-01`,
          endDate: `${year}-12-31`,
        });
        return queryAttendanceSummary(tx, fixture.schoolId, filter, "student", {
          limit: 1,
          offset: 0,
        });
      },
    );

    expect(result.total_groups).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.totals.total_records).toBe(0);
    expect(result.totals.present_percent).toBe(0);
  });

  test("keeps export status requester-only and records terminal enqueue failures", async () => {
    const requesterId = fixture.users.ORG_ADMIN.id;
    const otherAdminId = fixture.users.SUPER_ADMIN.id;
    const job = await withTenantTx(
      database.sql,
      { schoolId: fixture.schoolId, userId: requesterId },
      (tx) => createReportExportJob(tx, fixture.schoolId, requesterId, "xlsx"),
    );

    const visibleToRequester = await withTenantTx(
      database.sql,
      { schoolId: fixture.schoolId, userId: requesterId },
      (tx) => getReportExportJob(tx, fixture.schoolId, requesterId, job.id),
    );
    const hiddenFromOtherAdmin = await withTenantTx(
      database.sql,
      { schoolId: fixture.schoolId, userId: otherAdminId },
      (tx) => getReportExportJob(tx, fixture.schoolId, otherAdminId, job.id),
    );
    const otherTenant = await createFullTenant(database.sql);
    const hiddenFromOtherTenant = await withTenantTx(
      database.sql,
      { schoolId: otherTenant.schoolId, userId: otherTenant.users.ORG_ADMIN.id },
      (tx) => getReportExportJob(tx, otherTenant.schoolId, otherTenant.users.ORG_ADMIN.id, job.id),
    );

    expect(visibleToRequester?.status).toBe("pending");
    expect(hiddenFromOtherAdmin).toBeUndefined();
    expect(hiddenFromOtherTenant).toBeUndefined();

    await withTenantTx(database.sql, { schoolId: fixture.schoolId, userId: requesterId }, (tx) =>
      failReportExportJob(tx, fixture.schoolId, job.id, "Failed to enqueue export"),
    );
    const failed = await withTenantTx(
      database.sql,
      { schoolId: fixture.schoolId, userId: requesterId },
      (tx) => getReportExportJob(tx, fixture.schoolId, requesterId, job.id),
    );
    expect(failed).toMatchObject({
      status: "failed",
      storage_key: null,
      error_message: "Failed to enqueue export",
    });
    expect(failed?.completed_at).toBeInstanceOf(Date);
  });
});
