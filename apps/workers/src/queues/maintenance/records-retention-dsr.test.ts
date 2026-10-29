/**
 * School-defined record data in the GDPR pipeline and the sensitive-record retention sweep
 * (docs/modules/student-records.md "DSR" and "Retention"). Requires a live, migrated PostgreSQL
 * instance, gated on TEST_DATABASE_URL.
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
  fields: Record<"passport" | "busStop" | "medical" | "parentId", string>;
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
    for (const kind of ["student", "parent"] as const) {
      const [template] = await tx<{ id: string }[]>`
        INSERT INTO app.record_templates (school_id, subject_kind, published_version)
        VALUES (${schoolId}::uuid, ${kind}::app.record_subject_kind, 1) RETURNING id
      `;
      const [version] = await tx<{ id: string }[]>`
        INSERT INTO app.record_template_versions (school_id, template_id, version, published_by)
        VALUES (${schoolId}::uuid, ${template!.id}::uuid, 1, ${admin!.id}::uuid) RETURNING id
      `;
      const defs =
        kind === "student"
          ? ([
              ["passport", "short_text", "sensitive", null],
              ["busStop", "short_text", "standard", null],
              ["medical", "long_text", "sensitive", 6],
            ] as const)
          : ([["parentId", "short_text", "sensitive", null]] as const);
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

async function answer(
  s: School,
  subject: { kind: "student" | "parent"; id: string },
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
    INSERT INTO app.record_answers (school_id, subject_kind, student_id, parent_user_id, field_id,
      field_version_id, value, value_ciphertext, value_key_id, value_mask)
    VALUES (${s.schoolId}::uuid, ${subject.kind}::app.record_subject_kind,
      ${subject.kind === "student" ? subject.id : null}::uuid,
      ${subject.kind === "parent" ? subject.id : null}::uuid, ${fieldId}::uuid,
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
