/**
 * Integration test: runTenantExport against a real, disposable school fixture, with an in-memory
 * fake object store (no AWS dependency). The export is one ZIP archive; these tests open it and
 * check that it holds the data and the right people's files. Skipped without TEST_DATABASE_URL.
 */
import { createHash } from "node:crypto";

import { dsrExportArchiveKey } from "@studafy/constants";
import { DEVELOPMENT_RECORD_KEYRING } from "@studafy/records";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { createFakeExportStorage, readExportArchive } from "./__tests__/export-fakes";
import { runTenantExport } from "./tenant-export.worker";

import type { FakeExportStorage } from "./__tests__/export-fakes";
import type { ExportManifest } from "./export-manifest";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const dbTest = test.skipIf(!enabled);

let sql: Sql | undefined;
let schoolId: string;
/** The person exported in the per-user tests: a student. */
let userId: string;
let otherStudentUserId: string;
let teacherUserId: string;

const bytes = (text: string) => new TextEncoder().encode(text);
const OWN_HOMEWORK = bytes("%PDF-1.4 my own homework");
const OTHER_HOMEWORK = bytes("%PDF-1.4 someone else's homework");
const MATERIAL = bytes("lesson notes from the teacher");
const sha256 = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

/** Stored objects every test starts from; the "missing" material's key is deliberately absent. */
const stored = new Map<string, Uint8Array>();
let ownHomeworkKey: string;
let otherHomeworkKey: string;
let materialKey: string;

function storageWithFiles(): FakeExportStorage {
  const storage = createFakeExportStorage();
  for (const [key, body] of stored) storage.objects.set(key, body);
  return storage;
}

beforeAll(async () => {
  if (!enabled) return;
  sql = postgres(databaseUrl!, { max: 1, ssl: false, prepare: false });
  const [country] = await sql<{ id: string }[]>`SELECT id FROM app.countries LIMIT 1`;
  const [currency] = await sql<{ id: string }[]>`SELECT id FROM app.currencies LIMIT 1`;
  const tag = crypto.randomUUID().slice(0, 8);
  const slug = "dsr-export-test-" + tag;
  const [school] = await sql<{ id: string }[]>`
    INSERT INTO app.schools (slug, name, status, country_id, default_currency_id, email, normalized_email)
    VALUES (
      ${slug}, 'DSR Export Fixture', 'active', ${country!.id}, ${currency!.id},
      ${slug + "@example.com"}, ${slug + "@example.com"}
    )
    RETURNING id
  `;
  schoolId = school!.id;
  await sql`SELECT set_config('app.school_id', ${schoolId}, false)`;

  const user = async (email: string, name: string) => {
    const [row] = await sql!<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${email}, ${email}, ${name}, 'active')
      RETURNING id
    `;
    return row!.id;
  };
  const admin = await user("org-admin@example.com", "Org Admin");
  await sql`INSERT INTO app.user_roles (school_id, user_id, role) VALUES (${schoolId}::uuid, ${admin}::uuid, 'ORG_ADMIN')`;
  userId = await user("export-me@example.com", "Export Me");
  otherStudentUserId = await user("someone-else@example.com", "Someone Else");
  teacherUserId = await user("teacher@example.com", "The Teacher");

  const student = async (forUser: string, admission: string) => {
    const [row] = await sql!<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${schoolId}::uuid, ${forUser}::uuid, ${admission}, 'First', 'Last', 'enrolled')
      RETURNING id
    `;
    return row!.id;
  };
  const ownStudentId = await student(userId, "ADM-200");
  const otherStudentId = await student(otherStudentUserId, "ADM-201");

  const [teacher] = await sql<{ id: string }[]>`
    INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
    VALUES (${schoolId}::uuid, ${teacherUserId}::uuid, ${`EMP-${tag}`}, 'active')
    RETURNING id
  `;
  const [year] = await sql<{ id: string }[]>`
    INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
    VALUES (${schoolId}::uuid, ${`AY-${tag}`}, ${`AY ${tag}`}, '2026-01-01'::date, '2026-12-31'::date, 'active')
    RETURNING id
  `;
  const [term] = await sql<{ id: string }[]>`
    INSERT INTO app.terms
      (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
    VALUES (${schoolId}::uuid, ${year!.id}::uuid, ${`T-${tag}`}, ${`T ${tag}`}, 1::smallint,
            '2026-01-01'::date, '2026-06-30'::date, 'active')
    RETURNING id
  `;
  const [subject] = await sql<{ id: string }[]>`
    INSERT INTO app.subjects (school_id, code, name, status)
    VALUES (${schoolId}::uuid, ${`SUB-${tag}`}, ${`Subject ${tag}`}, 'active')
    RETURNING id
  `;
  const [course] = await sql<{ id: string }[]>`
    INSERT INTO app.courses (school_id, subject_id, code, name, credit_hours, status)
    VALUES (${schoolId}::uuid, ${subject!.id}::uuid, ${`CRS-${tag}`}, ${`Course ${tag}`}, 1, 'active')
    RETURNING id
  `;
  const [cls] = await sql<{ id: string }[]>`
    INSERT INTO app.classes
      (school_id, course_id, academic_year_id, term_id, lead_teacher_id, code, capacity, status)
    VALUES (${schoolId}::uuid, ${course!.id}::uuid, ${year!.id}::uuid, ${term!.id}::uuid,
            ${teacher!.id}::uuid, ${`CLS-${tag}`}, 32, 'active')
    RETURNING id
  `;

  materialKey = `permanent/${schoolId}/${crypto.randomUUID()}/lesson.txt`;
  const missingKey = `permanent/${schoolId}/${crypto.randomUUID()}/gone.txt`;
  for (const [key, title, name] of [
    [materialKey, "Lesson", "lesson.txt"],
    [missingKey, "Gone", "gone.txt"],
  ] as const) {
    await sql`
      INSERT INTO app.materials
        (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title,
         storage_key, original_file_name, mime_type, size_bytes, checksum_sha256)
      VALUES (${schoolId}::uuid, ${cls!.id}::uuid, ${teacherUserId}::uuid, ${teacherUserId}::uuid,
              ${title}, ${key}, ${name}, 'text/plain', ${MATERIAL.byteLength},
              ${key === materialKey ? sha256(MATERIAL) : null})
    `;
  }
  stored.set(materialKey, MATERIAL);

  const [assignment] = await sql<{ id: string }[]>`
    INSERT INTO app.assignments
      (school_id, class_id, created_by_user_id, last_edited_by_user_id, title, due_at, max_score)
    VALUES (${schoolId}::uuid, ${cls!.id}::uuid, ${teacherUserId}::uuid, ${teacherUserId}::uuid,
            'Essay', '2026-03-01T00:00:00Z', 10)
    RETURNING id
  `;
  // Both students upload a file with the same name: the archive must keep both apart.
  const submit = async (studentId: string, uploader: string, body: Uint8Array) => {
    const [submission] = await sql!<{ id: string }[]>`
      INSERT INTO app.assignment_submissions (school_id, assignment_id, student_id, last_edited_by_user_id)
      VALUES (${schoolId}::uuid, ${assignment!.id}::uuid, ${studentId}::uuid, ${uploader}::uuid)
      RETURNING id
    `;
    const key = `permanent/${schoolId}/${crypto.randomUUID()}/homework.pdf`;
    await sql!`
      INSERT INTO app.submission_attachments
        (school_id, submission_id, uploaded_by_user_id, storage_key, original_file_name, mime_type,
         size_bytes, checksum_sha256)
      VALUES (${schoolId}::uuid, ${submission!.id}::uuid, ${uploader}::uuid, ${key}, 'homework.pdf',
              'application/pdf', ${body.byteLength}, ${sha256(body)})
    `;
    stored.set(key, body);
    return key;
  };
  ownHomeworkKey = await submit(ownStudentId, userId, OWN_HOMEWORK);
  otherHomeworkKey = await submit(otherStudentId, otherStudentUserId, OTHER_HOMEWORK);
});

afterAll(async () => {
  if (!enabled) return;
  for (const table of [
    "submission_attachments",
    "assignment_submissions",
    "assignments",
    "materials",
    "classes",
    "courses",
    "subjects",
    "terms",
    "academic_years",
    "teachers",
    "students",
    "notification_preferences",
    "user_roles",
    "users",
  ]) {
    await sql!.unsafe(`DELETE FROM app."${table}" WHERE school_id = $1`, [schoolId]);
  }
  await sql!`DELETE FROM app.schools WHERE id = ${schoolId}::uuid`;
  await sql?.end({ timeout: 5 });
});

async function exportFor(storage: FakeExportStorage, subjectUserId: string | null) {
  const requestId = crypto.randomUUID();
  const result = await sql!.begin((tx) =>
    runTenantExport(tx, {
      s3: storage,
      requestId,
      schoolId,
      subjectScope: subjectUserId ? "user" : "tenant",
      subjectUserId,
      now: new Date("2026-09-09T12:00:00.000Z"),
      recordKeyring: DEVELOPMENT_RECORD_KEYRING,
    }),
  );
  return {
    requestId,
    result,
    archive: await readExportArchive(storage.objects.get(result.archiveKey)),
  };
}

describe("runTenantExport", () => {
  dbTest("a whole-school export is one ZIP archive with the data and every file", async () => {
    const storage = storageWithFiles();
    const { requestId, result, archive } = await exportFor(storage, null);

    expect(result.archiveKey).toBe(dsrExportArchiveKey(schoolId, requestId));
    expect(storage.dispositions.get(result.archiveKey)).toBe(
      'attachment; filename="studafy-export-2026-09-09.zip"',
    );
    // Nothing else is written: the archive is the whole export.
    expect([...storage.objects.keys()].filter((key) => key.startsWith("dsr-exports/"))).toEqual([
      result.archiveKey,
    ]);

    // The manifest inside the archive is the schema-verified one the worker returned.
    const manifest = JSON.parse(await archive.text("manifest.json")) as ExportManifest;
    expect(manifest).toEqual(result.manifest);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.subjectScope).toBe("tenant");
    // The bundle includes the school's own financial/legal-hold tables too -- export is not erasure.
    expect(manifest.retainedTables).toEqual([]);

    const usersEntry = manifest.tables.find((entry) => entry.table === "users")!;
    expect(usersEntry.rowCount).toBe(4);
    expect(usersEntry.path).toBe("data/users.json");
    const users = await archive.rows<{ id: string }>("users");
    expect(users).toHaveLength(4);
    expect(sha256(await archive.bytes(usersEntry.path))).toBe(usersEntry.sha256);
    expect(manifest.tables.some((entry) => entry.table === "classes")).toBe(true);

    // Every stored file is copied, byte for byte; same-named uploads are kept apart.
    const homework = manifest.files.filter((file) => file.table === "submission_attachments");
    expect(homework.map((file) => file.path).sort()).toEqual([
      "files/submissions/homework (2).pdf",
      "files/submissions/homework.pdf",
    ]);
    const copies = await Promise.all(homework.map((file) => archive.bytes(file.path!)));
    expect(copies.map((copy) => new TextDecoder().decode(copy)).sort()).toEqual(
      [OTHER_HOMEWORK, OWN_HOMEWORK].map((body) => new TextDecoder().decode(body)).sort(),
    );
    for (const file of homework) {
      expect(file.sha256).toBe(file.uploadSha256);
      expect(file.sha256).toBe(sha256(await archive.bytes(file.path!)));
    }
    expect(await archive.bytes("files/materials/lesson.txt")).toEqual(MATERIAL);

    // A file whose object is gone is listed without a path, and the README says so.
    const gone = manifest.files.find((file) => file.originalFileName === "gone.txt")!;
    expect(gone.path).toBeNull();
    const readme = await archive.text("README.txt");
    expect(readme).toContain("all of the data DSR Export Fixture holds in Studafy");
    expect(readme).toContain("data/users.json: 4 records");
    expect(readme).toContain("files/submissions/: 2 files");
    expect(readme).toContain("1 file is listed in manifest.json with no path");

    expect(archive.names.sort()).toEqual(
      [
        "README.txt",
        "manifest.json",
        ...manifest.tables.map((entry) => entry.path),
        ...manifest.files.flatMap((file) => (file.path ? [file.path] : [])),
      ].sort(),
    );
  });

  dbTest("a person's export holds their rows and their files, not other people's", async () => {
    const storage = storageWithFiles();
    const { result, archive } = await exportFor(storage, userId);
    const manifest = result.manifest;

    const usersEntry = manifest.tables.find((entry) => entry.table === "users")!;
    expect(usersEntry.rowCount).toBe(1);
    const [row] = await archive.rows<{ id: string }>("users");
    expect(row!.id).toBe(userId);
    // A table with no subject-link column at all (e.g. app.classes) contributes nothing.
    expect(manifest.tables.some((entry) => entry.table === "classes")).toBe(false);

    expect(manifest.files.map((file) => [file.table, file.path])).toEqual([
      ["submission_attachments", "files/submissions/homework.pdf"],
    ]);
    expect(await archive.bytes("files/submissions/homework.pdf")).toEqual(OWN_HOMEWORK);
    // Other people's files are never even read.
    expect(storage.opened).not.toContain(otherHomeworkKey);
    expect(storage.opened).not.toContain(materialKey);
    expect(storage.opened).toContain(ownHomeworkKey);

    const everything = (await Promise.all(archive.names.map((name) => archive.text(name)))).join(
      "\n",
    );
    expect(everything).not.toContain("someone else's homework");
    expect(everything).not.toContain(otherStudentUserId);

    const readme = await archive.text("README.txt");
    expect(readme).toContain("about Export Me");
    expect(readme).toContain("files/submissions/: 1 file,");
  });

  dbTest("a teacher's export holds what they uploaded, not their students' work", async () => {
    const storage = storageWithFiles();
    const { result, archive } = await exportFor(storage, teacherUserId);

    expect(result.manifest.files.map((file) => file.originalFileName).sort()).toEqual([
      "gone.txt",
      "lesson.txt",
    ]);
    expect(await archive.bytes("files/materials/lesson.txt")).toEqual(MATERIAL);
    expect(archive.names.some((name) => name.startsWith("files/submissions/"))).toBe(false);
    expect(storage.opened).not.toContain(ownHomeworkKey);
    expect(storage.opened).not.toContain(otherHomeworkKey);
  });
});
