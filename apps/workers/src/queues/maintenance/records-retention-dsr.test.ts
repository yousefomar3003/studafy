/**
 * School-defined record data in the GDPR pipeline and the sensitive-record retention sweep
 * (docs/modules/student-records.md "DSR" and "Retention") -- for students and parents, and for staff
 * and classes (000181). Requires a live, migrated PostgreSQL instance, gated on TEST_DATABASE_URL.
 */

import {
  DEVELOPMENT_RECORD_KEYRING,
  DEVELOPMENT_RECORD_KEYS_JSON,
  openRecordValue,
  parseRecordKeyring,
  sealRecordValue,
} from "@studafy/records";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { withSystemTenantTx } from "../../db/tenant-tx";

import { resealRecordValues } from "./record-key-rotation";
import { purgeExpiredSensitiveRecords } from "./record-retention-sweep";
import { eraseCustomListData, eraseRecordData } from "./records-dsr";
import { resolveSubjectIdentifiers } from "./subject-resolver";
import { runTenantErasure } from "./tenant-erasure.worker";
import { runTenantExport } from "./tenant-export.worker";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const describeDb = enabled ? describe : describe.skip;

let sql: Sql | undefined;

beforeAll(() => {
  if (!enabled) return;
  sql = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

const PASSPORT = "X9876543-PASSPORT";
const MONTH = 30 * 86_400_000;

interface School {
  schoolId: string;
  adminId: string;
  /** Field ids by name. */
  fields: Record<
    "passport" | "busStop" | "medical" | "parentId" | "staffId" | "qualification" | "busGroup",
    string
  >;
  /** Field version ids by field name. */
  versions: Record<string, string>;
}

async function school(): Promise<School> {
  const [country] = await sql!<{ id: string }[]>`SELECT id FROM app.countries LIMIT 1`;
  const [currency] = await sql!<{ id: string }[]>`SELECT id FROM app.currencies LIMIT 1`;
  const slug = "records-" + crypto.randomUUID().slice(0, 8);
  return withAdmin(undefined, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, status, country_id, default_currency_id, email, normalized_email)
      VALUES (${slug}, 'Records Fixture', 'active', ${country!.id}, ${currency!.id},
              ${slug + "@example.com"}, ${slug + "@example.com"})
      RETURNING id
    `;
    const schoolId = row!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [admin] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${slug + "-admin@example.com"}, ${slug + "-admin@example.com"}, 'Admin', 'active')
      RETURNING id
    `;
    await tx`INSERT INTO app.user_roles (school_id, user_id, role) VALUES (${schoolId}::uuid, ${admin!.id}::uuid, 'ORG_ADMIN')`;

    const fields = {} as School["fields"];
    const versions: Record<string, string> = {};
    for (const kind of ["student", "parent", "staff", "class"] as const) {
      const [template] = await tx<{ id: string }[]>`
        INSERT INTO app.record_templates (school_id, subject_kind, published_version)
        VALUES (${schoolId}::uuid, ${kind}::app.record_subject_kind, 1) RETURNING id
      `;
      const [version] = await tx<{ id: string }[]>`
        INSERT INTO app.record_template_versions (school_id, template_id, version, published_by)
        VALUES (${schoolId}::uuid, ${template!.id}::uuid, 1, ${admin!.id}::uuid) RETURNING id
      `;
      type FieldDef = readonly [keyof School["fields"], string, string, number | null];
      const byKind: Record<typeof kind, readonly FieldDef[]> = {
        student: [
          ["passport", "short_text", "sensitive", null],
          ["busStop", "short_text", "standard", null],
          ["medical", "long_text", "sensitive", 6],
        ],
        parent: [["parentId", "short_text", "sensitive", null]],
        staff: [
          ["staffId", "short_text", "sensitive", null],
          ["qualification", "short_text", "standard", null],
        ],
        class: [["busGroup", "short_text", "standard", null]],
      };
      const defs = byKind[kind];
      for (const [name, type, sensitivity, months] of defs) {
        const [field] = await tx<{ id: string }[]>`
          INSERT INTO app.record_fields (school_id, template_id, field_type, label_en, label_ar,
                                         sensitivity, retention_months, created_by, first_published_at)
          VALUES (${schoolId}::uuid, ${template!.id}::uuid, ${type}::app.record_field_type, ${name},
                  ${name}, ${sensitivity}::app.record_field_sensitivity, ${months}, ${admin!.id}::uuid,
                  CURRENT_TIMESTAMP)
          RETURNING id
        `;
        const [fieldVersion] = await tx<{ id: string }[]>`
          INSERT INTO app.record_field_versions (school_id, template_version_id, field_id, field_type,
            label_en, label_ar, required, options, sort_order, visibility, sensitivity, has_expiry,
            retention_months)
          VALUES (${schoolId}::uuid, ${version!.id}::uuid, ${field!.id}::uuid,
                  ${type}::app.record_field_type, ${name}, ${name}, false, '[]'::jsonb, 0,
                  'staff_only', ${sensitivity}::app.record_field_sensitivity, false, ${months})
          RETURNING id
        `;
        fields[name] = field!.id;
        versions[name] = fieldVersion!.id;
      }
    }
    return { schoolId, adminId: admin!.id, fields, versions };
  });
}

async function withAdmin<T>(
  schoolId: string | undefined,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
) {
  let result: T | undefined;
  await sql!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    if (schoolId) await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

async function student(s: School, leftMonthsAgo: number | null) {
  return withAdmin(s.schoolId, async (tx) => {
    const email = `student-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${s.schoolId}::uuid, ${email}, ${email}, 'Pupil', 'active') RETURNING id
    `;
    const status = leftMonthsAgo === null ? "enrolled" : "withdrawn";
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${s.schoolId}::uuid, ${user!.id}::uuid, ${"ADM-" + crypto.randomUUID().slice(0, 6)},
              'Pupil', 'Test', ${status}::app.student_status)
      RETURNING id
    `;
    if (leftMonthsAgo !== null) {
      await tx`
        UPDATE app.students SET left_at = ${new Date(Date.now() - leftMonthsAgo * MONTH)}
        WHERE id = ${row!.id}::uuid
      `;
    }
    return { studentId: row!.id, userId: user!.id };
  });
}

async function parent(s: School, childIds: string[]) {
  return withAdmin(s.schoolId, async (tx) => {
    const email = `parent-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${s.schoolId}::uuid, ${email}, ${email}, 'Guardian', 'active') RETURNING id
    `;
    await tx`INSERT INTO app.user_roles (school_id, user_id, role) VALUES (${s.schoolId}::uuid, ${user!.id}::uuid, 'PARENT')`;
    if (childIds.length > 0) {
      const [family] = await tx<{ id: string }[]>`
        INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
        VALUES (${s.schoolId}::uuid, 'Family', ${user!.id}::uuid) RETURNING id
      `;
      for (const childId of childIds) {
        await tx`
          INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
          VALUES (${s.schoolId}::uuid, ${family!.id}::uuid, ${user!.id}::uuid, ${childId}::uuid, 'father')
        `;
      }
    }
    return user!.id;
  });
}

/** A member of staff; `archivedMonthsAgo` archives their account that long ago. */
async function staffMember(s: School, archivedMonthsAgo: number | null) {
  return withAdmin(s.schoolId, async (tx) => {
    const email = `staff-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${s.schoolId}::uuid, ${email}, ${email}, 'Teacher', 'active') RETURNING id
    `;
    await tx`INSERT INTO app.user_roles (school_id, user_id, role) VALUES (${s.schoolId}::uuid, ${user!.id}::uuid, 'INSTRUCTOR')`;
    if (archivedMonthsAgo !== null) {
      await tx`UPDATE app.users SET status = 'archived' WHERE id = ${user!.id}::uuid`;
      await tx`
        UPDATE app.users SET archived_at = ${new Date(Date.now() - archivedMonthsAgo * MONTH)}
        WHERE id = ${user!.id}::uuid
      `;
    }
    return user!.id;
  });
}

/** A class, built on the minimum academic structure. */
async function aClass(s: School) {
  return withAdmin(s.schoolId, async (tx) => {
    const tag = crypto.randomUUID().slice(0, 6);
    const [teacherUser] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${s.schoolId}::uuid, ${tag + "-t@example.com"}, ${tag + "-t@example.com"}, 'Lead', 'active')
      RETURNING id
    `;
    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number)
      VALUES (${s.schoolId}::uuid, ${teacherUser!.id}::uuid, ${"EMP-" + tag})
      RETURNING id
    `;
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on)
      VALUES (${s.schoolId}::uuid, ${"AY-" + tag}, 'Year', '2026-09-01', '2027-06-30') RETURNING id
    `;
    const [term] = await tx<{ id: string }[]>`
      INSERT INTO app.terms (school_id, academic_year_id, code, name, starts_on, ends_on, sequence_number)
      VALUES (${s.schoolId}::uuid, ${year!.id}::uuid, ${"T-" + tag}, 'Term', '2026-09-01', '2026-12-31', 1)
      RETURNING id
    `;
    const [subject] = await tx<{ id: string }[]>`
      INSERT INTO app.subjects (school_id, code, name) VALUES (${s.schoolId}::uuid, ${"S-" + tag}, 'Maths')
      RETURNING id
    `;
    const [course] = await tx<{ id: string }[]>`
      INSERT INTO app.courses (school_id, subject_id, code, name)
      VALUES (${s.schoolId}::uuid, ${subject!.id}::uuid, ${"C-" + tag}, 'Maths 10') RETURNING id
    `;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.classes (school_id, course_id, academic_year_id, term_id, lead_teacher_id, code)
      VALUES (${s.schoolId}::uuid, ${course!.id}::uuid, ${year!.id}::uuid, ${term!.id}::uuid,
              ${teacher!.id}::uuid, ${"CLS-" + tag})
      RETURNING id
    `;
    return row!.id;
  });
}

const SUBJECT_COLUMN = {
  student: "student_id",
  parent: "parent_user_id",
  staff: "staff_user_id",
  class: "class_id",
} as const;

async function answer(
  s: School,
  subject: { kind: "student" | "parent" | "staff" | "class"; id: string },
  field: keyof School["fields"],
  value: string,
  sensitive: boolean,
) {
  const fieldId = s.fields[field];
  const sealed = sensitive
    ? sealRecordValue(
        DEVELOPMENT_RECORD_KEYRING,
        { schoolId: s.schoolId, subjectKind: subject.kind, subjectId: subject.id, fieldId },
        "short_text",
        value,
      )
    : null;
  await withAdmin(
    s.schoolId,
    (tx) => tx`
    INSERT INTO app.record_answers (school_id, subject_kind, ${tx(SUBJECT_COLUMN[subject.kind])},
      field_id, field_version_id, value, value_ciphertext, value_key_id, value_mask)
    VALUES (${s.schoolId}::uuid, ${subject.kind}::app.record_subject_kind, ${subject.id}::uuid,
      ${fieldId}::uuid,
      ${s.versions[field]!}::uuid, ${sealed ? null : tx.json(value)}::jsonb,
      ${sealed?.ciphertext ?? null}::bytea, ${sealed?.keyId ?? null}, ${sealed?.mask ?? null})
  `,
  );
}

async function remaining(s: School) {
  const rows = await withAdmin(
    s.schoolId,
    (tx) => tx<{ subject_id: string; field_id: string }[]>`
    SELECT subject_id, field_id FROM app.record_answers WHERE school_id = ${s.schoolId}::uuid
  `,
  );
  return rows.map((row) => `${row.subject_id}:${row.field_id}`).sort();
}

describeDb("sensitive record retention sweep", () => {
  test("deletes sensitive answers once their period has run, and only those", async () => {
    const s = await school();
    const current = await student(s, null);
    const leftLongAgo = await student(s, 13);
    const leftRecently = await student(s, 11);
    const leftSevenMonths = await student(s, 7);
    const parentOfLeaver = await parent(s, [leftLongAgo.studentId]);
    const parentWithCurrentChild = await parent(s, [leftLongAgo.studentId, current.studentId]);
    const unlinkedParent = await parent(s, []);

    for (const who of [current, leftLongAgo, leftRecently, leftSevenMonths]) {
      await answer(s, { kind: "student", id: who.studentId }, "passport", PASSPORT, true);
      await answer(s, { kind: "student", id: who.studentId }, "busStop", "Gate 3", false);
      await answer(s, { kind: "student", id: who.studentId }, "medical", "asthma", true);
    }
    for (const id of [parentOfLeaver, parentWithCurrentChild, unlinkedParent]) {
      await answer(s, { kind: "parent", id }, "parentId", PASSPORT, true);
    }

    const removed = { remove: async () => undefined };
    const result = await purgeExpiredSensitiveRecords(sql!, removed);
    expect(result.failed).toBe(0);

    const expected = [
      // Still at school: everything kept.
      `${current.studentId}:${s.fields.passport}`,
      `${current.studentId}:${s.fields.busStop}`,
      `${current.studentId}:${s.fields.medical}`,
      // Left 13 months ago: past the 12-month default and the 6-month medical period.
      `${leftLongAgo.studentId}:${s.fields.busStop}`,
      // Left 11 months ago: inside the default; the 6-month medical period has run.
      `${leftRecently.studentId}:${s.fields.passport}`,
      `${leftRecently.studentId}:${s.fields.busStop}`,
      // Left 7 months ago: medical (6 months) gone, passport (12) kept.
      `${leftSevenMonths.studentId}:${s.fields.passport}`,
      `${leftSevenMonths.studentId}:${s.fields.busStop}`,
      // A parent with a child still at school, and a parent linked to nobody, are kept.
      `${parentWithCurrentChild}:${s.fields.parentId}`,
      `${unlinkedParent}:${s.fields.parentId}`,
    ].sort();
    expect(await remaining(s)).toEqual(expected);

    const audits = await withAdmin(
      s.schoolId,
      (tx) => tx<{ payload: string }[]>`
      SELECT coalesce(old_values::text, '') || coalesce(new_values::text, '') AS payload
      FROM app.audit_logs
      WHERE school_id = ${s.schoolId}::uuid AND target_table = 'record_answers' AND action = 'delete'
    `,
    );
    expect(audits).toHaveLength(5);
    for (const audit of audits) expect(audit.payload).not.toContain(PASSPORT);

    // Idempotent: a second run finds nothing more.
    await purgeExpiredSensitiveRecords(sql!, removed);
    expect(await remaining(s)).toEqual(expected);
  });
});

describeDb("record data in the DSR pipeline", () => {
  test("a per-user export holds the subject's answers decrypted; erasure removes them", async () => {
    const s = await school();
    const child = await student(s, null);
    const other = await student(s, null);
    const guardian = await parent(s, [child.studentId]);
    await answer(s, { kind: "student", id: child.studentId }, "passport", PASSPORT, true);
    await answer(s, { kind: "student", id: child.studentId }, "busStop", "Gate 3", false);
    await answer(s, { kind: "student", id: other.studentId }, "busStop", "Gate 9", false);
    await answer(s, { kind: "parent", id: guardian }, "parentId", "G-445566", true);

    const objects = new Map<string, Uint8Array>();
    const s3 = {
      put: async (key: string, body: Uint8Array) => void objects.set(key, body),
    };
    const exportFor = async (userId: string) =>
      withSystemTenantTx(sql!, { schoolId: s.schoolId }, (tx) =>
        runTenantExport(tx, {
          s3,
          requestId: crypto.randomUUID(),
          schoolId: s.schoolId,
          subjectScope: "user",
          subjectUserId: userId,
          now: new Date(),
          recordKeyring: DEVELOPMENT_RECORD_KEYRING,
        }),
      );

    const childExport = await exportFor(child.userId);
    const entry = childExport.manifest.tables.find((table) => table.table === "record_answers")!;
    expect(entry.rowCount).toBe(2);
    const lines = new TextDecoder()
      .decode(objects.get(entry.storageKey)!)
      .split("\n")
      .map((line) => JSON.parse(line) as { label_en: string; value: unknown });
    expect(lines.map((line) => [line.label_en, line.value]).sort()).toEqual(
      [
        ["busStop", "Gate 3"],
        ["passport", PASSPORT],
      ].sort(),
    );
    // The generic dump never ships record ciphertext alongside.
    expect(childExport.manifest.tables.some((table) => table.table === "record_documents")).toBe(
      false,
    );

    const guardianExport = await exportFor(guardian);
    const guardianEntry = guardianExport.manifest.tables.find((t) => t.table === "record_answers")!;
    expect(new TextDecoder().decode(objects.get(guardianEntry.storageKey)!)).toContain("G-445566");

    const erasure = await withSystemTenantTx(sql!, { schoolId: s.schoolId }, async (tx) =>
      runTenantErasure(
        tx,
        s.schoolId,
        await resolveSubjectIdentifiers(tx, s.schoolId, child.userId),
      ),
    );
    expect(erasure.redactedTables).toContainEqual({
      table: "record_answers",
      action: "hard_deleted",
      columns: [],
      rows: 2,
    });
    expect(await remaining(s)).toEqual(
      [`${other.studentId}:${s.fields.busStop}`, `${guardian}:${s.fields.parentId}`].sort(),
    );
  });
});

describeDb("staff and class records in retention and the DSR pipeline", () => {
  test("a staff member's sensitive answers go once their account has been archived long enough", async () => {
    const s = await school();
    const current = await staffMember(s, null);
    const leftLongAgo = await staffMember(s, 13);
    const leftRecently = await staffMember(s, 2);
    const classId = await aClass(s);
    for (const id of [current, leftLongAgo, leftRecently]) {
      await answer(s, { kind: "staff", id }, "staffId", PASSPORT, true);
      await answer(s, { kind: "staff", id }, "qualification", "BEd", false);
    }
    await answer(s, { kind: "class", id: classId }, "busGroup", "Route 4", false);

    expect(
      (await purgeExpiredSensitiveRecords(sql!, { remove: async () => undefined })).failed,
    ).toBe(0);
    expect(await remaining(s)).toEqual(
      [
        `${current}:${s.fields.staffId}`,
        `${current}:${s.fields.qualification}`,
        // Archived 13 months ago: the sensitive ID is past the 12-month default; the rest stays.
        `${leftLongAgo}:${s.fields.qualification}`,
        `${leftRecently}:${s.fields.staffId}`,
        `${leftRecently}:${s.fields.qualification}`,
        `${classId}:${s.fields.busGroup}`,
      ].sort(),
    );
  });

  test("archiving a user stamps archived_at, and reactivating clears it", async () => {
    const s = await school();
    const id = await staffMember(s, null);
    const stamp = async () =>
      (
        await withAdmin(
          s.schoolId,
          (tx) => tx<{ archived_at: Date | null }[]>`
            SELECT archived_at FROM app.users WHERE id = ${id}::uuid
          `,
        )
      )[0]!.archived_at;
    expect(await stamp()).toBeNull();
    await withAdmin(
      s.schoolId,
      (tx) => tx`UPDATE app.users SET status = 'archived' WHERE id = ${id}::uuid`,
    );
    expect(await stamp()).not.toBeNull();
    await withAdmin(
      s.schoolId,
      (tx) => tx`UPDATE app.users SET status = 'active' WHERE id = ${id}::uuid`,
    );
    expect(await stamp()).toBeNull();
  });

  test("a staff member's export holds their answers opened; erasure takes them and never a class's", async () => {
    const s = await school();
    const teacher = await staffMember(s, null);
    const colleague = await staffMember(s, null);
    const classId = await aClass(s);
    await answer(s, { kind: "staff", id: teacher }, "staffId", PASSPORT, true);
    await answer(s, { kind: "staff", id: teacher }, "qualification", "BEd", false);
    await answer(s, { kind: "staff", id: colleague }, "qualification", "MEd", false);
    await answer(s, { kind: "class", id: classId }, "busGroup", "Route 4", false);

    const objects = new Map<string, Uint8Array>();
    const s3 = { put: async (key: string, body: Uint8Array) => void objects.set(key, body) };
    const exported = await withSystemTenantTx(sql!, { schoolId: s.schoolId }, (tx) =>
      runTenantExport(tx, {
        s3,
        requestId: crypto.randomUUID(),
        schoolId: s.schoolId,
        subjectScope: "user",
        subjectUserId: teacher,
        now: new Date(),
        recordKeyring: DEVELOPMENT_RECORD_KEYRING,
      }),
    );
    const entry = exported.manifest.tables.find((table) => table.table === "record_answers")!;
    expect(entry.rowCount).toBe(2);
    const lines = new TextDecoder()
      .decode(objects.get(entry.storageKey)!)
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { subject_kind: string; label_en: string; value: unknown },
      );
    expect(lines.map((line) => [line.subject_kind, line.label_en, line.value]).sort()).toEqual(
      [
        ["staff", "qualification", "BEd"],
        ["staff", "staffId", PASSPORT],
      ].sort(),
    );

    const erasure = await withSystemTenantTx(sql!, { schoolId: s.schoolId }, async (tx) =>
      runTenantErasure(tx, s.schoolId, await resolveSubjectIdentifiers(tx, s.schoolId, teacher)),
    );
    expect(erasure.redactedTables).toContainEqual({
      table: "record_answers",
      action: "hard_deleted",
      columns: [],
      rows: 2,
    });
    expect(await remaining(s)).toEqual(
      [`${colleague}:${s.fields.qualification}`, `${classId}:${s.fields.busGroup}`].sort(),
    );

    // A tenant closure takes everything, the class's record included.
    const closure = await withSystemTenantTx(sql!, { schoolId: s.schoolId }, (tx) =>
      eraseRecordData(tx, s.schoolId, undefined),
    );
    expect(closure.rows).toBe(2);
    expect(await remaining(s)).toEqual([]);
  });
});

describeDb("records key rotation", () => {
  test("re-seals every value under the current key, readable afterwards", async () => {
    const s = await school();
    const pupil = await student(s, null);
    await answer(s, { kind: "student", id: pupil.studentId }, "passport", PASSPORT, true);
    const rotated = parseRecordKeyring(
      JSON.stringify({
        ...JSON.parse(DEVELOPMENT_RECORD_KEYS_JSON),
        "rotated-2": Buffer.alloc(32, 5).toString("base64"),
      }),
      "rotated-2",
    );
    const result = await resealRecordValues(sql!, rotated);
    expect(result.failed).toBe(0);
    const [row] = await withAdmin(
      s.schoolId,
      (tx) => tx<{ value_ciphertext: Uint8Array; value_key_id: string; value_mask: string }[]>`
      SELECT value_ciphertext, value_key_id, value_mask FROM app.record_answers
      WHERE school_id = ${s.schoolId}::uuid
    `,
    );
    expect(row!.value_key_id).toBe("rotated-2");
    const opened = openRecordValue(
      parseRecordKeyring(
        JSON.stringify({ "rotated-2": Buffer.alloc(32, 5).toString("base64") }),
        "rotated-2",
      ),
      {
        schoolId: s.schoolId,
        subjectKind: "student",
        subjectId: pupil.studentId,
        fieldId: s.fields.passport,
      },
      { ciphertext: row!.value_ciphertext, keyId: row!.value_key_id, mask: row!.value_mask },
    );
    expect(opened.unwrap()).toBe(PASSPORT);

    // Rotate back, so values this run moved (in any fixture school) open with the development key
    // again on the next run against the same database.
    const back = parseRecordKeyring(
      JSON.stringify({
        ...JSON.parse(DEVELOPMENT_RECORD_KEYS_JSON),
        "rotated-2": Buffer.alloc(32, 5).toString("base64"),
      }),
      DEVELOPMENT_RECORD_KEYRING.currentKeyId,
    );
    expect((await resealRecordValues(sql!, back)).failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Custom lists (000182)
// ---------------------------------------------------------------------------

const LOCKER_CODE = "LOCK-7781-SECRET";

interface CustomListFixture {
  listId: string;
  codeColumn: string;
  sizeColumn: string;
  countColumn: string;
  options: Record<"s" | "m", string>;
}

async function customList(s: School): Promise<CustomListFixture> {
  return withAdmin(s.schoolId, async (tx) => {
    const [list] = await tx<{ id: string }[]>`
      INSERT INTO app.custom_lists (school_id, name_en, name_ar, audience, link_student,
                                    link_parent, link_staff, link_class, created_by)
      VALUES (${s.schoolId}::uuid, ${"Lockers " + crypto.randomUUID().slice(0, 6)}, 'الخزائن',
              'staff', true, true, true, true, ${s.adminId}::uuid)
      RETURNING id
    `;
    const column = async (type: string, label: string, sensitivity: string, order: number) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.custom_list_columns (school_id, list_id, field_type, label_en, label_ar,
                                             sensitivity, sort_order)
        VALUES (${s.schoolId}::uuid, ${list!.id}::uuid, ${type}::app.record_field_type, ${label},
                ${label + " ar"}, ${sensitivity}::app.record_field_sensitivity, ${order})
        RETURNING id
      `;
      return row!.id;
    };
    const codeColumn = await column("short_text", "Locker code", "sensitive", 0);
    const sizeColumn = await column("single_choice", "Size", "standard", 1);
    const countColumn = await column("number", "Keys", "standard", 2);
    const options = {} as CustomListFixture["options"];
    for (const [index, value] of (["s", "m"] as const).entries()) {
      const [option] = await tx<{ id: string }[]>`
        INSERT INTO app.custom_list_column_options (school_id, list_id, column_id, value, label_en,
                                                    label_ar, sort_order)
        VALUES (${s.schoolId}::uuid, ${list!.id}::uuid, ${sizeColumn}::uuid, ${value},
                ${value.toUpperCase()}, ${value + " ar"}, ${index})
        RETURNING id
      `;
      options[value] = option!.id;
    }
    return { listId: list!.id, codeColumn, sizeColumn, countColumn, options };
  });
}

/** A row with a sealed locker code, a size and a key count; `link` null for an unlinked row. */
async function listRow(
  s: School,
  list: CustomListFixture,
  link: { kind: "student" | "parent" | "staff" | "class"; id: string } | null,
  code: string,
) {
  return withAdmin(s.schoolId, async (tx) => {
    const column =
      link === null
        ? null
        : link.kind === "student"
          ? "student_id"
          : link.kind === "class"
            ? "class_id"
            : "user_id";
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.custom_list_rows (school_id, list_id, link_kind, student_id, user_id, class_id)
      VALUES (${s.schoolId}::uuid, ${list.listId}::uuid,
              ${link?.kind ?? null}::app.custom_list_link_kind,
              ${column === "student_id" ? link!.id : null}::uuid,
              ${column === "user_id" ? link!.id : null}::uuid,
              ${column === "class_id" ? link!.id : null}::uuid)
      RETURNING id
    `;
    const sealed = sealRecordValue(
      DEVELOPMENT_RECORD_KEYRING,
      {
        schoolId: s.schoolId,
        subjectKind: "custom_list_row",
        subjectId: row!.id,
        fieldId: list.codeColumn,
      },
      "short_text",
      code,
    );
    await tx`
      INSERT INTO app.custom_list_values (school_id, list_id, row_id, column_id, value_ciphertext,
                                          value_key_id, value_mask)
      VALUES (${s.schoolId}::uuid, ${list.listId}::uuid, ${row!.id}::uuid, ${list.codeColumn}::uuid,
              ${sealed.ciphertext}::bytea, ${sealed.keyId}, ${sealed.mask})
    `;
    await tx`
      INSERT INTO app.custom_list_values (school_id, list_id, row_id, column_id, option_id)
      VALUES (${s.schoolId}::uuid, ${list.listId}::uuid, ${row!.id}::uuid, ${list.sizeColumn}::uuid,
              ${list.options.m}::uuid)
    `;
    await tx`
      INSERT INTO app.custom_list_values (school_id, list_id, row_id, column_id, value_number)
      VALUES (${s.schoolId}::uuid, ${list.listId}::uuid, ${row!.id}::uuid, ${list.countColumn}::uuid, 2)
    `;
    return row!.id;
  });
}

async function customListCounts(s: School) {
  const [counts] = await withAdmin(
    s.schoolId,
    (tx) => tx<{ lists: number; columns: number; options: number; rows: number; values: number }[]>`
    SELECT (SELECT count(*)::int FROM app.custom_lists WHERE school_id = ${s.schoolId}::uuid) AS lists,
           (SELECT count(*)::int FROM app.custom_list_columns WHERE school_id = ${s.schoolId}::uuid) AS columns,
           (SELECT count(*)::int FROM app.custom_list_column_options WHERE school_id = ${s.schoolId}::uuid) AS options,
           (SELECT count(*)::int FROM app.custom_list_rows WHERE school_id = ${s.schoolId}::uuid) AS rows,
           (SELECT count(*)::int FROM app.custom_list_values WHERE school_id = ${s.schoolId}::uuid) AS values
  `,
  );
  return counts!;
}

async function remainingListRows(s: School) {
  const rows = await withAdmin(
    s.schoolId,
    (tx) => tx<{ id: string }[]>`
    SELECT id FROM app.custom_list_rows WHERE school_id = ${s.schoolId}::uuid
  `,
  );
  return rows.map((row) => row.id).sort();
}

describeDb("custom lists in the DSR pipeline", () => {
  test("a person's export holds their linked rows with sensitive cells opened, and nobody else's", async () => {
    const s = await school();
    const pupil = await student(s, null);
    const other = await student(s, null);
    const list = await customList(s);
    await listRow(s, list, { kind: "student", id: pupil.studentId }, LOCKER_CODE);
    await listRow(s, list, { kind: "student", id: other.studentId }, "OTHER-CODE-1234");

    const objects = new Map<string, Uint8Array>();
    const s3 = { put: async (key: string, body: Uint8Array) => void objects.set(key, body) };
    const exported = await withSystemTenantTx(sql!, { schoolId: s.schoolId }, (tx) =>
      runTenantExport(tx, {
        s3,
        requestId: crypto.randomUUID(),
        schoolId: s.schoolId,
        subjectScope: "user",
        subjectUserId: pupil.userId,
        now: new Date(),
        recordKeyring: DEVELOPMENT_RECORD_KEYRING,
      }),
    );
    const entry = exported.manifest.tables.find((table) => table.table === "custom_list_rows")!;
    expect(entry.rowCount).toBe(1);
    const body = new TextDecoder().decode(objects.get(entry.storageKey)!);
    expect(body).not.toContain("OTHER-CODE-1234");
    const line = JSON.parse(body) as {
      link_kind: string;
      link_id: string;
      list_name_ar: string;
      cells: { label_en: string; sensitivity: string; value: unknown; choices?: unknown[] }[];
    };
    expect(line.link_kind).toBe("student");
    expect(line.link_id).toBe(pupil.studentId);
    expect(line.list_name_ar).toBe("الخزائن");
    expect(line.cells.map((cell) => [cell.label_en, cell.value])).toEqual([
      ["Locker code", LOCKER_CODE],
      ["Size", "m"],
      ["Keys", 2],
    ]);
    expect(line.cells[1]!.choices).toEqual([{ value: "m", label_en: "M", label_ar: "m ar" }]);
    // The cells table, ciphertext and all, never ships through the generic dump.
    expect(exported.manifest.tables.some((table) => table.table === "custom_list_values")).toBe(
      false,
    );
    expect(exported.manifest.tables.filter((t) => t.table === "custom_list_rows")).toHaveLength(1);
  });

  test("erasure deletes a person's rows and cells only; class and unlinked rows stay", async () => {
    const s = await school();
    const pupil = await student(s, null);
    const other = await student(s, null);
    const guardian = await parent(s, [pupil.studentId]);
    const teacher = await staffMember(s, null);
    const classId = await aClass(s);
    const list = await customList(s);
    await listRow(s, list, { kind: "student", id: pupil.studentId }, LOCKER_CODE);
    const otherRow = await listRow(s, list, { kind: "student", id: other.studentId }, "X-1");
    const guardianRow = await listRow(s, list, { kind: "parent", id: guardian }, "X-2");
    const teacherRow = await listRow(s, list, { kind: "staff", id: teacher }, "X-3");
    const classRow = await listRow(s, list, { kind: "class", id: classId }, "X-4");
    const unlinkedRow = await listRow(s, list, null, "X-5");

    const erasure = await withSystemTenantTx(sql!, { schoolId: s.schoolId }, async (tx) =>
      runTenantErasure(
        tx,
        s.schoolId,
        await resolveSubjectIdentifiers(tx, s.schoolId, pupil.userId),
      ),
    );
    expect(erasure.redactedTables).toContainEqual({
      table: "custom_list_rows",
      action: "hard_deleted",
      columns: [],
      rows: 1,
    });
    expect(await remainingListRows(s)).toEqual(
      [otherRow, guardianRow, teacherRow, classRow, unlinkedRow].sort(),
    );
    // Five rows of three cells each remain: the erased row's cells went with it.
    expect((await customListCounts(s)).values).toBe(15);

    // A member of staff's request reaches their row by user_id.
    await withSystemTenantTx(sql!, { schoolId: s.schoolId }, async (tx) =>
      runTenantErasure(tx, s.schoolId, await resolveSubjectIdentifiers(tx, s.schoolId, teacher)),
    );
    expect(await remainingListRows(s)).toEqual(
      [otherRow, guardianRow, classRow, unlinkedRow].sort(),
    );
  });

  test("a tenant closure deletes every list with its columns, choices, rows and cells", async () => {
    const s = await school();
    const pupil = await student(s, null);
    const classId = await aClass(s);
    const list = await customList(s);
    await customList(s);
    await listRow(s, list, { kind: "student", id: pupil.studentId }, LOCKER_CODE);
    await listRow(s, list, { kind: "class", id: classId }, "X-4");
    expect(await customListCounts(s)).toEqual({
      lists: 2,
      columns: 6,
      options: 4,
      rows: 2,
      values: 6,
    });

    const closure = await withSystemTenantTx(sql!, { schoolId: s.schoolId }, (tx) =>
      eraseCustomListData(tx, s.schoolId, undefined),
    );
    expect(closure).toEqual({ rows: 2, lists: 2 });
    expect(await customListCounts(s)).toEqual({
      lists: 0,
      columns: 0,
      options: 0,
      rows: 0,
      values: 0,
    });
  });

  test("a closure export holds every row; key rotation re-seals list cells", async () => {
    const s = await school();
    const pupil = await student(s, null);
    const classId = await aClass(s);
    const list = await customList(s);
    const rowId = await listRow(s, list, { kind: "student", id: pupil.studentId }, LOCKER_CODE);
    await listRow(s, list, { kind: "class", id: classId }, "X-4");

    const objects = new Map<string, Uint8Array>();
    const s3 = { put: async (key: string, body: Uint8Array) => void objects.set(key, body) };
    const exported = await withSystemTenantTx(sql!, { schoolId: s.schoolId }, (tx) =>
      runTenantExport(tx, {
        s3,
        requestId: crypto.randomUUID(),
        schoolId: s.schoolId,
        subjectScope: "tenant",
        subjectUserId: null,
        now: new Date(),
        recordKeyring: DEVELOPMENT_RECORD_KEYRING,
      }),
    );
    const entry = exported.manifest.tables.find((table) => table.table === "custom_list_rows")!;
    expect(entry.rowCount).toBe(2);

    const rotatedKey = Buffer.alloc(32, 7).toString("base64");
    const rotated = parseRecordKeyring(
      JSON.stringify({ ...JSON.parse(DEVELOPMENT_RECORD_KEYS_JSON), "rotated-3": rotatedKey }),
      "rotated-3",
    );
    expect((await resealRecordValues(sql!, rotated)).failed).toBe(0);
    const [cell] = await withAdmin(
      s.schoolId,
      (tx) => tx<{ value_ciphertext: Uint8Array; value_key_id: string; value_mask: string }[]>`
      SELECT value_ciphertext, value_key_id, value_mask FROM app.custom_list_values
      WHERE school_id = ${s.schoolId}::uuid AND row_id = ${rowId}::uuid
        AND value_ciphertext IS NOT NULL
    `,
    );
    expect(cell!.value_key_id).toBe("rotated-3");
    const opened = openRecordValue(
      parseRecordKeyring(JSON.stringify({ "rotated-3": rotatedKey }), "rotated-3"),
      {
        schoolId: s.schoolId,
        subjectKind: "custom_list_row",
        subjectId: rowId,
        fieldId: list.codeColumn,
      },
      { ciphertext: cell!.value_ciphertext, keyId: cell!.value_key_id, mask: cell!.value_mask },
    );
    expect(opened.unwrap()).toBe(LOCKER_CODE);

    // Rotate back so later runs against the same database open with the development key.
    const back = parseRecordKeyring(
      JSON.stringify({ ...JSON.parse(DEVELOPMENT_RECORD_KEYS_JSON), "rotated-3": rotatedKey }),
      DEVELOPMENT_RECORD_KEYRING.currentKeyId,
    );
    expect((await resealRecordValues(sql!, back)).failed).toBe(0);
  });
});
