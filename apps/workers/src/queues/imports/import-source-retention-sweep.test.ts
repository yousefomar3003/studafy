/**
 * Student import retention and erasure (docs/security/data_retention_and_dsr_policy.md "Student
 * import files"), against a real database: the daily sweep deletes original files and leftover
 * cells past the school's period (180 days, or shorter by setting), and the GDPR pipeline deletes
 * them on a tenant closure and a person's own leftover cells on a per-person request. Skipped (as
 * `skipIf` tests) unless TEST_DATABASE_URL points at a migrated database.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { eraseImportData } from "../maintenance/imports-dsr";

import { purgeExpiredImportSources } from "./import-source-retention-sweep";
import { backfillUnmappedColumns } from "./unmapped-columns-backfill";

import type { Sql, TransactionSql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const dbTest = test.skipIf(!databaseUrl);
const DAY = 86_400_000;

let db: Sql | undefined;

beforeAll(() => {
  if (!databaseUrl) return;
  db = postgres(databaseUrl, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

function asAdmin<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

interface Fixture {
  schoolId: string;
  adminId: string;
  studentId: string;
  studentUserId: string;
  otherStudentId: string;
  parentId: string;
}

async function seedSchool(): Promise<Fixture> {
  const slug = `import-ret-${crypto.randomUUID().slice(0, 8)}`;
  const schoolId = await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${slug}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        (SELECT id FROM app.countries WHERE alpha2_code = 'US'),
        (SELECT id FROM app.currencies WHERE code = 'USD')
      )
      RETURNING id
    `;
    return school!.id;
  });
  return asAdmin(schoolId, async (tx) => {
    const user = async (email: string, role: string): Promise<string> => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, status)
        VALUES (${schoolId}::uuid, ${email}, ${email}, 'active') RETURNING id
      `;
      await tx`
        INSERT INTO app.user_roles (school_id, user_id, role)
        VALUES (${schoolId}::uuid, ${row!.id}::uuid, ${role}::app.user_role)
      `;
      return row!.id;
    };
    const student = async (userId: string, admission: string): Promise<string> => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
        VALUES (${schoolId}::uuid, ${userId}::uuid, ${admission}, 'A', 'B') RETURNING id
      `;
      return row!.id;
    };
    const adminId = await user(`admin@${slug}.local`, "ORG_ADMIN");
    const studentUserId = await user(`s1@${slug}.local`, "STUDENT");
    const otherUserId = await user(`s2@${slug}.local`, "STUDENT");
    const parentId = await user(`p@${slug}.local`, "PARENT");
    return {
      schoolId,
      adminId,
      studentUserId,
      studentId: await student(studentUserId, "S-1"),
      otherStudentId: await student(otherUserId, "S-2"),
      parentId,
    };
  });
}

/** A completed import uploaded `ageDays` ago, with a kept file and two leftover lines. */
async function seedImport(fixture: Fixture, ageDays: number, now: Date): Promise<string> {
  const uploadedAt = new Date(now.getTime() - ageDays * DAY);
  return asAdmin(fixture.schoolId, async (tx) => {
    const id = crypto.randomUUID();
    await tx`
      INSERT INTO app.student_imports (
        id, school_id, uploaded_by, confirmed_by, status, file_name, row_count, valid_rows,
        source_headers, column_mapping, created_at, updated_at, confirmed_at, completed_at,
        source_storage_key, source_file_name, source_size_bytes, source_uploaded_at
      ) VALUES (
        ${id}::uuid, ${fixture.schoolId}::uuid, ${fixture.adminId}::uuid, ${fixture.adminId}::uuid,
        'completed', 'sis.csv', 2, 2, '["Blood Type"]'::jsonb, '{}'::jsonb, ${uploadedAt},
        ${uploadedAt}, ${uploadedAt}, ${uploadedAt},
        ${`permanent/${fixture.schoolId}/${id}/sis.csv`}, 'sis.csv', 120, ${uploadedAt}
      )
    `;
    await tx`
      INSERT INTO app.student_import_rows
        (school_id, import_id, line_number, source, student_id, parent_user_id)
      VALUES
        (${fixture.schoolId}::uuid, ${id}::uuid, 2, '{"Blood Type": "A+"}'::jsonb,
         ${fixture.studentId}::uuid, ${fixture.parentId}::uuid),
        (${fixture.schoolId}::uuid, ${id}::uuid, 3, '{"Blood Type": "B+"}'::jsonb,
         ${fixture.otherStudentId}::uuid, NULL)
    `;
    return id;
  });
}

async function importState(fixture: Fixture, importId: string) {
  return asAdmin(fixture.schoolId, async (tx) => {
    const [row] = await tx<
      {
        source_storage_key: string | null;
        source_file_name: string | null;
        source_removed_reason: string | null;
        cells_purged_at: Date | null;
        cells: number;
      }[]
    >`
      SELECT source_storage_key, source_file_name, source_removed_reason, cells_purged_at,
             (SELECT count(*)::int FROM app.student_import_rows AS r
              WHERE r.school_id = i.school_id AND r.import_id = i.id) AS cells
      FROM app.student_imports AS i
      WHERE i.school_id = ${fixture.schoolId}::uuid AND i.id = ${importId}::uuid
    `;
    return row!;
  });
}

function recordingRemover() {
  const removed: string[] = [];
  return {
    removed,
    remove: async (key: string) => {
      removed.push(key);
    },
  };
}

describe("import source retention sweep", () => {
  dbTest("deletes files and leftover cells past 180 days, keeps younger ones", async () => {
    const now = new Date();
    const fixture = await seedSchool();
    const old = await seedImport(fixture, 181, now);
    const young = await seedImport(fixture, 179, now);
    const storage = recordingRemover();

    const result = await purgeExpiredImportSources(db!, storage, now);
    expect(result.failed).toBe(0);
    expect(storage.removed).toContain(`permanent/${fixture.schoolId}/${old}/sis.csv`);
    expect(storage.removed).not.toContain(`permanent/${fixture.schoolId}/${young}/sis.csv`);

    const expired = await importState(fixture, old);
    expect(expired.source_storage_key).toBeNull();
    expect(expired.source_file_name).toBe("sis.csv"); // kept as history
    expect(expired.source_removed_reason).toBe("retention");
    expect(expired.cells).toBe(0);
    expect(expired.cells_purged_at).not.toBeNull();

    const kept = await importState(fixture, young);
    expect(kept.source_storage_key).not.toBeNull();
    expect(kept.cells).toBe(2);
  });

  dbTest("honours a school's shorter period", async () => {
    const now = new Date();
    const fixture = await seedSchool();
    await asAdmin(
      fixture.schoolId,
      (tx) => tx`
        INSERT INTO app.student_import_settings (school_id, source_retention_days, updated_by)
        VALUES (${fixture.schoolId}::uuid, 30, ${fixture.adminId}::uuid)
      `,
    );
    const importId = await seedImport(fixture, 31, now);

    await purgeExpiredImportSources(db!, recordingRemover(), now);
    const state = await importState(fixture, importId);
    expect(state.source_storage_key).toBeNull();
    expect(state.cells).toBe(0);
  });
});

describe("import data in the GDPR pipeline", () => {
  dbTest("a per-person erasure deletes their leftover cells and retains the files", async () => {
    const now = new Date();
    const fixture = await seedSchool();
    const importId = await seedImport(fixture, 1, now);

    const erasure = await asAdmin(fixture.schoolId, (tx) =>
      eraseImportData(tx, fixture.schoolId, {
        userId: fixture.studentUserId,
        studentId: fixture.studentId,
        teacherId: null,
      }),
    );
    expect(erasure.rows).toBe(1);
    expect(erasure.storageKeys).toEqual([]);
    expect(erasure.retained.map((entry) => entry.table)).toEqual(["student_imports"]);

    const state = await importState(fixture, importId);
    expect(state.cells).toBe(1); // the other student's line
    expect(state.source_storage_key).not.toBeNull();

    // As a parent: their tag on a line goes with the line.
    const asParent = await asAdmin(fixture.schoolId, (tx) =>
      eraseImportData(tx, fixture.schoolId, {
        userId: fixture.parentId,
        studentId: null,
        teacherId: null,
      }),
    );
    expect(asParent.rows).toBe(0); // the parent's line was the erased student's
  });

  dbTest("a tenant closure deletes every file and every leftover cell", async () => {
    const now = new Date();
    const fixture = await seedSchool();
    const first = await seedImport(fixture, 1, now);
    const second = await seedImport(fixture, 10, now);

    const erasure = await asAdmin(fixture.schoolId, (tx) =>
      eraseImportData(tx, fixture.schoolId, undefined),
    );
    expect(erasure.rows).toBe(4);
    expect(erasure.storageKeys.sort()).toEqual(
      [
        `permanent/${fixture.schoolId}/${first}/sis.csv`,
        `permanent/${fixture.schoolId}/${second}/sis.csv`,
      ].sort(),
    );
    for (const importId of [first, second]) {
      const state = await importState(fixture, importId);
      expect(state.source_storage_key).toBeNull();
      expect(state.source_removed_reason).toBe("erasure");
      expect(state.cells).toBe(0);
    }
  });
});

describe("unmapped column backfill", () => {
  dbTest("records the unmapped columns of an import that has none, once", async () => {
    const fixture = await seedSchool();
    const importId = await asAdmin(fixture.schoolId, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.student_imports (
          school_id, uploaded_by, status, file_name, row_count, valid_rows, source_headers,
          column_mapping
        ) VALUES (
          ${fixture.schoolId}::uuid, ${fixture.adminId}::uuid, 'completed', 'old.csv', 1, 1,
          '["Student ID", "First", "Last", "Blood Type"]'::jsonb,
          '{"admission_number": "student id", "first_name": "First", "last_name": "Last"}'::jsonb
        )
        RETURNING id
      `;
      return row!.id;
    });

    const first = await backfillUnmappedColumns(db!);
    expect(first.failed).toBe(0);
    const second = await backfillUnmappedColumns(db!);
    expect(second.failed).toBe(0);

    const rows = await asAdmin(
      fixture.schoolId,
      (tx) => tx<{ position: number; header: string; normalized_header: string }[]>`
        SELECT position, header, normalized_header FROM app.student_import_unmapped_columns
        WHERE import_id = ${importId}::uuid
      `,
    );
    expect([...rows]).toEqual([
      { position: 3, header: "Blood Type", normalized_header: "bloodtype" },
    ]);
  });
});
