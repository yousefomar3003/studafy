/**
 * Staging-to-target student import migration (ST-299), against a real database.
 *
 * Stages a non-template CSV (renamed, reordered headers) through the mapping engine exactly as the
 * API does, then drives the worker. Proves: creates/updates/conflicts land as planned; a failure
 * part-way rolls back every write; a retry after that failure succeeds; and a retry after success is
 * a no-op. Skipped (as `skipIf` tests) unless TEST_DATABASE_URL is set.
 */

import { readCsvSource, stageRows, suggestColumnMapping } from "@studafy/student-import";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { migrateStagedImport } from "./worker";

import type { JSONValue, Sql, TransactionSql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const dbTest = test.skipIf(!databaseUrl);

let db: Sql | undefined;

beforeAll(() => {
  if (!databaseUrl) return;
  db = postgres(databaseUrl, { max: 4, ssl: false, prepare: false });
});

// Seeded schools are left in place, as the other worker suites do: the test database is disposable,
// and app.audit_logs is append-only, so a school this suite audited cannot be deleted anyway.
afterAll(async () => {
  await db?.end({ timeout: 5 });
});

// Rejections are captured with .catch() rather than `expect(...).rejects`: under bun 1.3 the latter,
// awaiting a postgres.js-backed promise, left the pool unable to dispatch the next transaction and
// the suite hung until timeout.

function asAdmin<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

interface Fixture {
  schoolId: string;
  slug: string;
  adminId: string;
  existingStudentId: string;
  existingParentId: string;
}

async function seedSchool(): Promise<Fixture> {
  const slug = `import-map-${crypto.randomUUID().slice(0, 8)}`;
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

    const adminId = await user(`admin@${slug}.local`, "ORG_ADMIN");
    await user(`teacher@${slug}.local`, "INSTRUCTOR");
    const existingUserId = await user(`old@${slug}.local`, "STUDENT");
    const existingParentId = await user(`parent@${slug}.local`, "PARENT");

    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${schoolId}::uuid, ${existingUserId}::uuid, 'OLD-1', 'Old', 'Name', 'applicant')
      RETURNING id
    `;
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}::uuid, 'Parent', ${existingParentId}::uuid) RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links
        (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${schoolId}::uuid, ${family!.id}::uuid, ${existingParentId}::uuid,
              ${student!.id}::uuid, 'guardian')
    `;

    return { schoolId, slug, adminId, existingStudentId: student!.id, existingParentId };
  });
}

/** Stage a CSV the way the API upload does, with the suggested mapping, as a confirmed import. */
async function stageConfirmedImport(fixture: Fixture, csv: string): Promise<string> {
  const source = readCsvSource(csv);
  const mapping = suggestColumnMapping(source.headers);
  const staged = stageRows(source, mapping);
  expect(staged.issues).toEqual([]);

  return asAdmin(fixture.schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.student_imports (
        school_id, uploaded_by, confirmed_by, status, file_name, row_count, valid_rows,
        header_line, source_headers, column_mapping, confirmed_at
      ) VALUES (
        ${fixture.schoolId}::uuid, ${fixture.adminId}::uuid, ${fixture.adminId}::uuid, 'confirmed',
        'sis-export.csv', ${staged.rows.length}, ${staged.rows.length}, ${source.header_line},
        ${tx.json(source.headers)}::jsonb, ${tx.json(mapping as JSONValue)}::jsonb, now()
      )
      RETURNING id
    `;
    for (const stagedRow of staged.rows) {
      await tx`
        INSERT INTO app.student_import_rows (school_id, import_id, line_number, source, record)
        VALUES (
          ${fixture.schoolId}::uuid, ${row!.id}::uuid, ${stagedRow.line_number},
          ${tx.json(stagedRow.source)}::jsonb, ${tx.json(stagedRow.record as unknown as JSONValue)}::jsonb
        )
      `;
    }
    return row!.id;
  });
}

function mixedCsv(slug: string): string {
  return [
    "SIS export,,,,,,",
    "Surname,Given Name,Student ID,E-mail,Enrollment Status,Guardian Email,Relationship",
    // create, with a new parent and a new link
    `Doe,Jane,NEW-1,jane@${slug}.local,Enrolled,mum@${slug}.local,Mother`,
    // create, reusing the parent created on the line above
    `Doe,John,NEW-2,john@${slug}.local,,mum@${slug}.local,mother`,
    // update: status changes and the existing link's relationship changes
    `Name,Old,OLD-1,old@${slug}.local,enrolled,parent@${slug}.local,father`,
    // conflict: same admission number as an earlier line
    `Dup,Dup,NEW-1,dup@${slug}.local,,,`,
    // conflict: a staff account's email
    `Teach,Er,NEW-3,teacher@${slug}.local,,,`,
  ].join("\n");
}

async function counts(schoolId: string): Promise<Record<string, number>> {
  return asAdmin(schoolId, async (tx) => {
    const [row] = await tx<Record<string, string>[]>`
      SELECT
        (SELECT count(*) FROM app.students WHERE school_id = ${schoolId}::uuid)::text AS students,
        (SELECT count(*) FROM app.users WHERE school_id = ${schoolId}::uuid)::text AS users,
        (SELECT count(*) FROM app.parent_child_links WHERE school_id = ${schoolId}::uuid)::text AS links,
        (SELECT count(*) FROM app.audit_logs WHERE school_id = ${schoolId}::uuid)::text AS audits
    `;
    return Object.fromEntries(Object.entries(row!).map(([k, v]) => [k, Number(v)]));
  });
}

async function importState(
  schoolId: string,
  importId: string,
): Promise<{ status: string; summary: unknown }> {
  return asAdmin(schoolId, async (tx) => {
    const [row] = await tx<{ status: string; summary: unknown }[]>`
      SELECT status::text AS status, summary FROM app.student_imports WHERE id = ${importId}::uuid
    `;
    return row!;
  });
}

describe("student import staging migration", () => {
  dbTest("migrates a mapped, non-template CSV and is a no-op on retry", async () => {
    const fixture = await seedSchool();
    const importId = await stageConfirmedImport(fixture, mixedCsv(fixture.slug));
    const before = await counts(fixture.schoolId);

    const summary = await migrateStagedImport(db!, { importId, schoolId: fixture.schoolId });

    expect(summary).toEqual({
      students_created: 2,
      students_updated: 1,
      students_skipped: 2,
      conflicts: 2,
      parents_created: 1,
      parents_linked: 2,
    });
    expect(await importState(fixture.schoolId, importId)).toEqual({ status: "completed", summary });

    const after = await counts(fixture.schoolId);
    expect(after.students - before.students).toBe(2);
    expect(after.users - before.users).toBe(3); // Jane, John, and their new parent
    expect(after.links - before.links).toBe(2);

    await asAdmin(fixture.schoolId, async (tx) => {
      const [old] = await tx<{ status: string; relationship: string }[]>`
        SELECT s.status::text AS status, l.relationship::text AS relationship
        FROM app.students AS s
        JOIN app.parent_child_links AS l ON l.student_id = s.id AND l.school_id = s.school_id
        WHERE s.id = ${fixture.existingStudentId}::uuid
      `;
      expect(old).toEqual({ status: "enrolled", relationship: "father" });

      const [jane] = await tx<{ status: string }[]>`
        SELECT status::text AS status FROM app.students
        WHERE school_id = ${fixture.schoolId}::uuid AND admission_number = 'NEW-1'
      `;
      expect(jane!.status).toBe("enrolled");

      const actors = await tx<{ actor_id: string; target_table: string }[]>`
        SELECT actor_id, target_table FROM app.audit_logs
        WHERE school_id = ${fixture.schoolId}::uuid
      `;
      expect(actors.every((a) => a.actor_id === fixture.adminId)).toBe(true);
      expect(new Set(actors.map((a) => a.target_table))).toEqual(
        new Set([
          "users",
          "user_roles",
          "students",
          "families",
          "parent_child_links",
          "student_imports",
        ]),
      );
    });

    const retried = await migrateStagedImport(db!, { importId, schoolId: fixture.schoolId });
    expect(retried).toEqual(summary);
    expect(await counts(fixture.schoolId)).toEqual(after);
  });

  dbTest("a failure part-way rolls back every write, and the retry then succeeds", async () => {
    const fixture = await seedSchool();
    const importId = await stageConfirmedImport(fixture, mixedCsv(fixture.slug));
    const before = await counts(fixture.schoolId);

    // Corrupt the last valid line past what validation would allow, so the INSERT fails after the
    // earlier lines have already been written inside the migration transaction.
    await asAdmin(
      fixture.schoolId,
      (tx) => tx`
      UPDATE app.student_import_rows
      SET record = jsonb_set(record, '{first_name}', '" padded "')
      WHERE import_id = ${importId}::uuid AND record->>'admission_number' = 'NEW-2'
    `,
    );
    const failure = await migrateStagedImport(db!, { importId, schoolId: fixture.schoolId }).catch(
      (error: unknown) => error,
    );
    expect(String(failure)).toContain("ck_users_display_name");
    expect((await importState(fixture.schoolId, importId)).status).toBe("failed");
    expect(await counts(fixture.schoolId)).toEqual(before);

    await asAdmin(
      fixture.schoolId,
      (tx) => tx`
      UPDATE app.student_import_rows
      SET record = jsonb_set(record, '{first_name}', '"John"')
      WHERE import_id = ${importId}::uuid AND record->>'admission_number' = 'NEW-2'
    `,
    );

    const summary = await migrateStagedImport(db!, { importId, schoolId: fixture.schoolId });
    expect(summary.students_created).toBe(2);
    expect((await importState(fixture.schoolId, importId)).status).toBe("completed");
  });

  dbTest("refuses an import that was never confirmed, without marking it failed", async () => {
    const fixture = await seedSchool();
    const importId = await stageConfirmedImport(fixture, mixedCsv(fixture.slug));
    await asAdmin(
      fixture.schoolId,
      (tx) => tx`
      UPDATE app.student_imports SET status = 'validated' WHERE id = ${importId}::uuid
    `,
    );

    const refusal = await migrateStagedImport(db!, { importId, schoolId: fixture.schoolId }).catch(
      (error: unknown) => error,
    );
    expect(String(refusal)).toContain("not confirmed");
    expect((await importState(fixture.schoolId, importId)).status).toBe("validated");
  });
});
