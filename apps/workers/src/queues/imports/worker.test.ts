/**
 * Staging-to-target student import migration (ST-299), against a real database.
 *
 * Stages a non-template CSV (renamed, reordered headers) through the mapping engine exactly as the
 * API does, then drives the worker. Proves: creates/updates/conflicts land as planned; a failure
 * part-way rolls back every write; a retry after that failure succeeds; and a retry after success is
 * a no-op. Skipped (as `skipIf` tests) unless TEST_DATABASE_URL is set.
 */

import { DEVELOPMENT_RECORD_KEYRING, openRecordValue } from "@studafy/records";
import { readCsvSource, stageRows, suggestColumnMapping } from "@studafy/student-import";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { migrateStagedImport } from "./worker";

import type { ImportRecordField } from "@studafy/student-import";
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
async function stageConfirmedImport(
  fixture: Fixture,
  csv: string,
  recordFields: ImportRecordField[] = [],
): Promise<string> {
  const source = readCsvSource(csv);
  const mapping = suggestColumnMapping(source.headers, recordFields);
  const staged = stageRows(source, mapping, recordFields);
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
    // update: status changes; the parent email belongs to an existing account, so it is a
    // PARENT_ACCOUNT_EXISTS parent conflict -- the student updates, no link is made or changed
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

    const summary = await migrateStagedImport(
      db!,
      { importId, schoolId: fixture.schoolId },
      DEVELOPMENT_RECORD_KEYRING,
    );

    expect(summary).toEqual({
      students_created: 2,
      students_updated: 1,
      students_skipped: 2,
      conflicts: 2,
      parents_created: 1,
      parents_linked: 2,
      parent_conflicts: 1,
      record_answers: 0,
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
      // The existing parent was never matched by email: the old link keeps its relationship.
      expect(old).toEqual({ status: "enrolled", relationship: "guardian" });

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

    const retried = await migrateStagedImport(
      db!,
      { importId, schoolId: fixture.schoolId },
      DEVELOPMENT_RECORD_KEYRING,
    );
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
    const failure = await migrateStagedImport(
      db!,
      { importId, schoolId: fixture.schoolId },
      DEVELOPMENT_RECORD_KEYRING,
    ).catch((error: unknown) => error);
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

    const summary = await migrateStagedImport(
      db!,
      { importId, schoolId: fixture.schoolId },
      DEVELOPMENT_RECORD_KEYRING,
    );
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

    const refusal = await migrateStagedImport(
      db!,
      { importId, schoolId: fixture.schoolId },
      DEVELOPMENT_RECORD_KEYRING,
    ).catch((error: unknown) => error);
    expect(String(refusal)).toContain("not confirmed");
    expect((await importState(fixture.schoolId, importId)).status).toBe("validated");
  });
});

/** Publish a one-version student record template straight into the tables, as a publish would. */
async function publishStudentTemplate(
  fixture: Fixture,
  fields: { label: string; sensitive: boolean }[],
): Promise<ImportRecordField[]> {
  return asAdmin(fixture.schoolId, async (tx) => {
    const [template] = await tx<{ id: string }[]>`
      INSERT INTO app.record_templates (school_id, subject_kind, published_version)
      VALUES (${fixture.schoolId}::uuid, 'student', 1) RETURNING id
    `;
    const [version] = await tx<{ id: string }[]>`
      INSERT INTO app.record_template_versions (school_id, template_id, version, published_by)
      VALUES (${fixture.schoolId}::uuid, ${template!.id}::uuid, 1, ${fixture.adminId}::uuid)
      RETURNING id
    `;
    const out: ImportRecordField[] = [];
    for (const [index, field] of fields.entries()) {
      const sensitivity = field.sensitive ? "sensitive" : "standard";
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.record_fields (school_id, template_id, field_type, label_en, label_ar,
                                       sensitivity, sort_order, created_by, first_published_at)
        VALUES (${fixture.schoolId}::uuid, ${template!.id}::uuid, 'short_text', ${field.label},
                ${field.label}, ${sensitivity}::app.record_field_sensitivity, ${index},
                ${fixture.adminId}::uuid, now())
        RETURNING id
      `;
      await tx`
        INSERT INTO app.record_field_versions (school_id, template_version_id, field_id, field_type,
          label_en, label_ar, required, options, sort_order, visibility, sensitivity, has_expiry)
        VALUES (${fixture.schoolId}::uuid, ${version!.id}::uuid, ${row!.id}::uuid, 'short_text',
                ${field.label}, ${field.label}, false, '[]'::jsonb, ${index}, 'staff_only',
                ${sensitivity}::app.record_field_sensitivity, false)
      `;
      out.push({
        id: row!.id,
        field_type: "short_text",
        options: [],
        label_en: field.label,
        label_ar: field.label,
        sensitivity,
      });
    }
    return out;
  });
}

describe("parents are never matched by email", () => {
  dbTest(
    "an existing account's email imports the student unlinked; siblings share one new parent",
    async () => {
      const fixture = await seedSchool();
      const csv = [
        "Surname,Given Name,Student ID,E-mail,Guardian Email,Relationship",
        // Two siblings sharing one new parent email: one parent, one household, two links.
        `Haddad,Rana,SIB-1,rana@${fixture.slug}.local,new-dad@${fixture.slug}.local,father`,
        `Haddad,Omar,SIB-2,omar@${fixture.slug}.local,NEW-DAD@${fixture.slug}.local,father`,
        // An email that belongs to an existing parent account: imported, never linked to it.
        `Saleh,Huda,EXIST-1,huda@${fixture.slug}.local,parent@${fixture.slug}.local,mother`,
        // An email that belongs to a staff account: same rule.
        `Saleh,Ali,EXIST-2,ali@${fixture.slug}.local,teacher@${fixture.slug}.local,father`,
      ].join("\n");
      const importId = await stageConfirmedImport(fixture, csv);

      const summary = await migrateStagedImport(
        db!,
        { importId, schoolId: fixture.schoolId },
        DEVELOPMENT_RECORD_KEYRING,
      );
      expect(summary).toMatchObject({
        students_created: 4,
        parents_created: 1,
        parents_linked: 2,
        parent_conflicts: 2,
      });

      await asAdmin(fixture.schoolId, async (tx) => {
        const links = await tx<{ admission_number: string; email: string; family_id: string }[]>`
        SELECT s.admission_number, u.normalized_email AS email, l.family_id
        FROM app.parent_child_links AS l
        JOIN app.students AS s ON s.id = l.student_id AND s.school_id = l.school_id
        JOIN app.users AS u ON u.id = l.parent_user_id AND u.school_id = l.school_id
        WHERE l.school_id = ${fixture.schoolId}::uuid AND s.admission_number LIKE 'SIB-%'
           OR (l.school_id = ${fixture.schoolId}::uuid AND s.admission_number LIKE 'EXIST-%')
        ORDER BY s.admission_number
      `;
        expect(links.map((l) => l.admission_number)).toEqual(["SIB-1", "SIB-2"]);
        expect(new Set(links.map((l) => l.email))).toEqual(
          new Set([`new-dad@${fixture.slug}.local`]),
        );
        expect(new Set(links.map((l) => l.family_id)).size).toBe(1);

        // The existing parent gained no child and no role change.
        const [existing] = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.parent_child_links
        WHERE school_id = ${fixture.schoolId}::uuid AND parent_user_id = ${fixture.existingParentId}::uuid
      `;
        expect(existing!.count).toBe(1);
        const [staffParent] = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.user_roles AS r
        JOIN app.users AS u ON u.id = r.user_id AND u.school_id = r.school_id
        WHERE r.school_id = ${fixture.schoolId}::uuid AND u.normalized_email = ${`teacher@${fixture.slug}.local`}
          AND r.role = 'PARENT'
      `;
        expect(staffParent!.count).toBe(0);

        // The applied import's staged cells are gone.
        const [staged] = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.student_import_rows WHERE import_id = ${importId}::uuid
      `;
        expect(staged!.count).toBe(0);
      });
    },
  );
});

describe("student record template columns", () => {
  dbTest(
    "writes answers, sealing the sensitive ones, and audits them without the value",
    async () => {
      const fixture = await seedSchool();
      const [busStop, nationalId] = await publishStudentTemplate(fixture, [
        { label: "Bus stop", sensitive: false },
        { label: "National ID", sensitive: true },
      ]);
      const csv = [
        "Surname,Given Name,Student ID,E-mail,Bus stop,National ID",
        `Nasser,Layla,REC-1,layla@${fixture.slug}.local,Gate 3,784-1990-1234567-1`,
      ].join("\n");
      const importId = await stageConfirmedImport(fixture, csv, [busStop!, nationalId!]);

      const summary = await migrateStagedImport(
        db!,
        { importId, schoolId: fixture.schoolId },
        DEVELOPMENT_RECORD_KEYRING,
      );
      expect(summary).toMatchObject({ students_created: 1, record_answers: 2 });

      await asAdmin(fixture.schoolId, async (tx) => {
        const answers = await tx<
          {
            field_id: string;
            subject_id: string;
            value: unknown;
            value_ciphertext: Uint8Array | null;
            value_key_id: string | null;
            value_mask: string | null;
          }[]
        >`
        SELECT field_id, subject_id, value, value_ciphertext, value_key_id, value_mask
        FROM app.record_answers WHERE school_id = ${fixture.schoolId}::uuid
      `;
        const plain = answers.find((a) => a.field_id === busStop!.id)!;
        expect(plain.value).toBe("Gate 3");
        const sealed = answers.find((a) => a.field_id === nationalId!.id)!;
        expect(sealed.value).toBeNull();
        const opened = openRecordValue(
          DEVELOPMENT_RECORD_KEYRING,
          {
            schoolId: fixture.schoolId,
            subjectKind: "student",
            subjectId: sealed.subject_id,
            fieldId: nationalId!.id,
          },
          {
            ciphertext: sealed.value_ciphertext!,
            keyId: sealed.value_key_id!,
            mask: sealed.value_mask!,
          },
        );
        expect(opened.unwrap()).toBe("784-1990-1234567-1");

        const audits = await tx<{ payload: string }[]>`
        SELECT coalesce(old_values::text, '') || coalesce(new_values::text, '') AS payload
        FROM app.audit_logs
        WHERE school_id = ${fixture.schoolId}::uuid AND target_table IN ('record_answers', 'student_imports')
      `;
        expect(audits.some((a) => a.payload.includes(nationalId!.id))).toBe(true);
        for (const audit of audits) expect(audit.payload).not.toContain("1234567");
      });
    },
  );
});
