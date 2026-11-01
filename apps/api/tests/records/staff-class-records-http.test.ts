/**
 * Staff and class records (docs/modules/student-records.md "Staff and class records", 000176):
 * the template rules for the two subjects, who reads and edits a staff member's record and a
 * class's, sensitive staff values (masked, encrypted at rest, audited reveal), a staff member's own
 * read, documents under each subject's content class, the missing-information lists, and keeping an
 * unknown column of the users and classes CSV imports as a record field -- only for the rows that
 * import created. Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/records/staff-class-records-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createTeacher,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { StorageService } from "../../src/lib/storage";
import type { TenantFixture, TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";

const describeDb = integrationEnabled ? describe : describe.skip;

interface StoredObject {
  contentType: string;
  sizeBytes: number;
}

function fakeStorage(): StorageService & {
  objects: Map<string, StoredObject>;
  sensitiveCopies: string[];
} {
  const objects = new Map<string, StoredObject>();
  const sensitiveCopies: string[] = [];
  const base: StorageService = {
    ttlSeconds: 900,
    check: async () => true,
    presign(key, _method, _contentType, ttlOverrideSeconds) {
      return {
        url: `https://storage.example/${encodeURIComponent(key)}?signed`,
        expiresAt: new Date(Date.now() + (ttlOverrideSeconds ?? 900) * 1000),
      };
    },
    async exists(key) {
      return objects.has(key);
    },
    async size(key) {
      return objects.get(key)?.sizeBytes ?? 0;
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { contentType: object.contentType, sizeBytes: object.sizeBytes } : null;
    },
    async checksumSha256() {
      return "a".repeat(64);
    },
    async copy(source, destination, options) {
      const object = objects.get(source);
      if (object) objects.set(destination, { ...object });
      if (options?.sensitive) sensitiveCopies.push(destination);
    },
    async remove(key) {
      objects.delete(key);
    },
    async *list(prefix) {
      for (const [key, object] of objects) {
        if (key.startsWith(prefix)) yield { key, sizeBytes: object.sizeBytes };
      }
    },
  };
  return Object.assign(base, { objects, sensitiveCopies });
}

const storage = fakeStorage();
let database: TestDatabase | undefined;
let harness: TestApp | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({ database: database.sql, storage });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
  channel: "web";
}

interface World {
  fixture: TenantFixture;
  schoolId: string;
  classId: string;
  admin: Actor;
  principal: Actor;
  finance: Actor;
  /** Leads the fixture class. */
  teacher: Actor;
  /** Teaches nothing. */
  otherTeacher: Actor;
  parent: Actor;
}

const SALARY = "4,250 JOD";
const NATIONAL_ID = "9881234567";

function actor(schoolId: string, userId: string, role: Role): Actor {
  return { schoolId, userId, roles: [role], channel: "web" };
}

async function newUser(schoolId: string, role: Role, name: string) {
  const user = await createUser(database!.sql, schoolId, {
    email: `${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@test.local`,
    displayName: name,
  });
  await assignRole(database!.sql, schoolId, user.id, role);
  return user;
}

async function world(): Promise<World> {
  const fixture = await createFullTenant(database!.sql);
  const schoolId = fixture.schoolId;
  const principal = await newUser(schoolId, ROLES.PRINCIPAL, "Head Teacher");
  const finance = await newUser(schoolId, ROLES.FINANCE, "Bursar");
  const parent = await newUser(schoolId, ROLES.PARENT, "Rana Haddad");
  await assignRole(database!.sql, schoolId, fixture.teachers[0]!.userId, ROLES.INSTRUCTOR);
  const other = await createTeacher(database!.sql, schoolId);
  await assignRole(database!.sql, schoolId, other.userId, ROLES.INSTRUCTOR);
  return {
    fixture,
    schoolId,
    classId: fixture.cls.id,
    admin: actor(schoolId, fixture.users.ORG_ADMIN.id, ROLES.ORG_ADMIN),
    principal: actor(schoolId, principal.id, ROLES.PRINCIPAL),
    finance: actor(schoolId, finance.id, ROLES.FINANCE),
    teacher: actor(schoolId, fixture.teachers[0]!.userId, ROLES.INSTRUCTOR),
    otherTeacher: actor(schoolId, other.userId, ROLES.INSTRUCTOR),
    parent: actor(schoolId, parent.id, ROLES.PARENT),
  };
}

function call(who: Actor, method: string, path: string, body?: unknown) {
  return authenticatedRequest(harness!, method, path, who, {
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface FieldDto {
  id: string;
  label_en: string;
}

interface EntryDto {
  field: { id: string; label_en: string; sensitivity: string };
  value: unknown;
  masked: boolean;
  mask: string | null;
  missing: boolean;
  document: { status: string; sensitive: boolean } | null;
}

async function addField(
  who: Actor,
  kind: "staff" | "class",
  body: Record<string, unknown>,
): Promise<FieldDto> {
  const response = await call(who, "POST", `/api/record-templates/${kind}/fields`, {
    label_ar: "حقل",
    ...body,
  });
  expect(response.status).toBe(201);
  return json<FieldDto>(response);
}

async function publish(who: Actor, kind: "staff" | "class") {
  const response = await call(who, "POST", `/api/record-templates/${kind}/publish`);
  expect(response.status).toBe(201);
}

/** Qualification (required), contract type (choice), salary (sensitive), licence (document). */
async function staffTemplate(w: World) {
  const qualification = await addField(w.admin, "staff", {
    field_type: "short_text",
    label_en: "Qualification",
    required: true,
  });
  const contract = await addField(w.admin, "staff", {
    field_type: "single_choice",
    label_en: "Contract type",
    options: [
      { value: "permanent", label_en: "Permanent", label_ar: "دائم" },
      { value: "fixed", label_en: "Fixed term", label_ar: "محدد المدة" },
    ],
  });
  const salary = await addField(w.admin, "staff", {
    field_type: "short_text",
    label_en: "Monthly salary",
    sensitivity: "sensitive",
    required: true,
  });
  const licence = await addField(w.admin, "staff", {
    field_type: "document",
    label_en: "Teaching licence",
  });
  await publish(w.admin, "staff");
  return { qualification, contract, salary, licence };
}

/** Bus group (teacher-visible), homeroom notes (leadership only, required). */
async function classTemplate(w: World) {
  const busGroup = await addField(w.principal, "class", {
    field_type: "short_text",
    label_en: "Bus group",
    visibility: "teachers",
  });
  const homeroom = await addField(w.principal, "class", {
    field_type: "long_text",
    label_en: "Homeroom notes",
    required: true,
  });
  await publish(w.principal, "class");
  return { busGroup, homeroom };
}

function labels(entries: EntryDto[]) {
  return entries.map((entry) => entry.field.label_en).sort();
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

describeDb("staff and class templates", () => {
  test("a staff field is staff_only; a class field is staff_only or teachers, never sensitive", async () => {
    const w = await world();
    const staffTeachers = await call(w.admin, "POST", "/api/record-templates/staff/fields", {
      field_type: "short_text",
      label_en: "Pay grade",
      label_ar: "الدرجة",
      visibility: "teachers",
    });
    expect(staffTeachers.status).toBe(422);
    expect((await json<{ code: string }>(staffTeachers)).code).toBe("RECORD_FIELD_INVALID");

    const classSensitive = await call(w.admin, "POST", "/api/record-templates/class/fields", {
      field_type: "short_text",
      label_en: "Medical",
      label_ar: "طبي",
      sensitivity: "sensitive",
    });
    expect(classSensitive.status).toBe(422);

    const classParent = await call(w.admin, "POST", "/api/record-templates/class/fields", {
      field_type: "short_text",
      label_en: "Parent note",
      label_ar: "ملاحظة",
      visibility: "parent",
    });
    expect(classParent.status).toBe(422);

    // A sensitive staff field and a teacher-visible class field are fine.
    await addField(w.admin, "staff", {
      field_type: "short_text",
      label_en: "National ID",
      sensitivity: "sensitive",
    });
    await addField(w.admin, "class", {
      field_type: "short_text",
      label_en: "Bus group",
      visibility: "teachers",
    });
  });

  test("templates for both use recordTemplate:manage: the principal builds them, a teacher cannot", async () => {
    const w = await world();
    await addField(w.principal, "staff", { field_type: "short_text", label_en: "Subject area" });
    await publish(w.principal, "staff");
    for (const who of [w.teacher, w.finance, w.parent]) {
      const response = await call(who, "GET", "/api/record-templates/class");
      expect(response.status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// Staff records
// ---------------------------------------------------------------------------

describeDb("staff records", () => {
  test("ORG_ADMIN fills in a staff record; a sensitive value is masked and sealed at rest", async () => {
    const w = await world();
    const fields = await staffTemplate(w);
    const put = await call(w.admin, "PUT", `/api/staff/${w.teacher.userId}/records`, {
      answers: [
        { field_id: fields.qualification.id, value: "BEd Mathematics" },
        { field_id: fields.contract.id, value: "permanent" },
        { field_id: fields.salary.id, value: SALARY },
      ],
    });
    expect(put.status).toBe(200);
    expect(put.headers.get("cache-control")).toBe("no-store");
    const body = await json<{ entries: EntryDto[]; missing_required: number }>(put);
    const salary = body.entries.find((entry) => entry.field.id === fields.salary.id)!;
    expect(salary.value).toBeNull();
    expect(salary.masked).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SALARY);
    expect(body.missing_required).toBe(0);

    const [row] = await database!.sql<
      { value: unknown; value_ciphertext: Uint8Array | null; subject_kind: string }[]
    >`
      SELECT a.value, a.value_ciphertext, a.subject_kind::text
      FROM app.record_answers AS a
      WHERE a.staff_user_id = ${w.teacher.userId}::uuid AND a.field_id = ${fields.salary.id}::uuid
    `;
    expect(row!.subject_kind).toBe("staff");
    expect(row!.value).toBeNull();
    expect(row!.value_ciphertext).not.toBeNull();

    // No audit row carries the salary.
    const audits = await database!.sql<{ payload: string }[]>`
      SELECT coalesce(old_values::text, '') || coalesce(new_values::text, '') AS payload
      FROM app.audit_logs
      WHERE school_id = ${w.schoolId}::uuid AND target_table = 'record_answers'
    `;
    expect(audits.length).toBeGreaterThan(0);
    for (const audit of audits) expect(audit.payload).not.toContain("4,250");
  });

  test("the reveal is ORG_ADMIN's and audited; the principal never sees a sensitive field", async () => {
    const w = await world();
    const fields = await staffTemplate(w);
    await call(w.admin, "PUT", `/api/staff/${w.teacher.userId}/records`, {
      answers: [
        { field_id: fields.qualification.id, value: "BEd" },
        { field_id: fields.salary.id, value: SALARY },
      ],
    });

    const revealed = await call(
      w.admin,
      "POST",
      `/api/staff/${w.teacher.userId}/records/${fields.salary.id}/reveal`,
    );
    expect(revealed.status).toBe(200);
    expect((await json<{ value: string }>(revealed)).value).toBe(SALARY);
    const [audit] = await database!.sql<{ action: string; actor_id: string }[]>`
      SELECT action::text, actor_id FROM app.audit_logs
      WHERE school_id = ${w.schoolId}::uuid AND action = 'read'
        AND new_values->>'field_id' = ${fields.salary.id}
    `;
    expect(audit).toEqual({ action: "read", actor_id: w.admin.userId });

    const asPrincipal = await call(w.principal, "GET", `/api/staff/${w.teacher.userId}/records`);
    expect(asPrincipal.status).toBe(200);
    const principalView = await json<{ entries: EntryDto[] }>(asPrincipal);
    expect(labels(principalView.entries)).toEqual(
      ["Contract type", "Qualification", "Teaching licence"].sort(),
    );
    expect(
      (
        await call(
          w.principal,
          "POST",
          `/api/staff/${w.teacher.userId}/records/${fields.salary.id}/reveal`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(w.principal, "PUT", `/api/staff/${w.teacher.userId}/records`, {
          answers: [{ field_id: fields.qualification.id, value: "MEd" }],
        })
      ).status,
    ).toBe(403);
  });

  test("teachers, finance and parents cannot read a colleague's record", async () => {
    const w = await world();
    await staffTemplate(w);
    for (const who of [w.teacher, w.otherTeacher, w.finance, w.parent]) {
      const response = await call(who, "GET", `/api/staff/${w.principal.userId}/records`);
      expect(response.status).toBe(403);
    }
  });

  test("a staff member reads their own non-sensitive fields; a parent has no staff record", async () => {
    const w = await world();
    const fields = await staffTemplate(w);
    await call(w.admin, "PUT", `/api/staff/${w.teacher.userId}/records`, {
      answers: [
        { field_id: fields.qualification.id, value: "BEd Mathematics" },
        { field_id: fields.salary.id, value: SALARY },
      ],
    });
    const own = await call(w.teacher, "GET", "/api/me/staff-record");
    expect(own.status).toBe(200);
    const body = await json<{ subject_id: string; entries: EntryDto[] }>(own);
    expect(body.subject_id).toBe(w.teacher.userId);
    expect(labels(body.entries)).toEqual(
      ["Contract type", "Qualification", "Teaching licence"].sort(),
    );
    expect(body.entries.find((e) => e.field.id === fields.qualification.id)!.value).toBe(
      "BEd Mathematics",
    );
    expect(JSON.stringify(body)).not.toContain(SALARY);

    // Another teacher's own record is empty: the row scope never hands them a colleague's answer.
    const otherOwn = await json<{ entries: EntryDto[] }>(
      await call(w.otherTeacher, "GET", "/api/me/staff-record"),
    );
    expect(otherOwn.entries.every((entry) => entry.value === null)).toBe(true);

    expect((await call(w.parent, "GET", "/api/me/staff-record")).status).toBe(403);
  });

  test("the subject must hold a staff role; another school's admin sees nothing", async () => {
    const w = await world();
    await staffTemplate(w);
    const asParentSubject = await call(w.admin, "GET", `/api/staff/${w.parent.userId}/records`);
    expect(asParentSubject.status).toBe(404);
    expect((await json<{ code: string }>(asParentSubject)).code).toBe("RECORD_SUBJECT_NOT_FOUND");

    const other = await world();
    const crossTenant = await call(other.admin, "GET", `/api/staff/${w.teacher.userId}/records`);
    expect(crossTenant.status).toBe(404);
  });

  test("a sensitive staff document is staged under staffRecord.sensitiveDocument and sealed", async () => {
    const w = await world();
    const passport = await addField(w.admin, "staff", {
      field_type: "document",
      label_en: "Passport scan",
      sensitivity: "sensitive",
    });
    await publish(w.admin, "staff");

    // A principal cannot even stage the upload.
    const refused = await call(w.principal, "POST", "/api/storage/uploads/request-upload", {
      content_class: "staffRecord.sensitiveDocument",
      file_name: "passport.pdf",
      content_type: "application/pdf",
      size_bytes: 1024,
    });
    expect(refused.status).toBe(403);

    // A phone photo (HEIC) passes the ordinary class but not the sensitive one the field needs.
    const heic = await call(w.admin, "POST", "/api/storage/uploads/request-upload", {
      content_class: "staffRecord.document",
      file_name: "passport.heic",
      content_type: "image/heic",
      size_bytes: 1024,
    });
    const { storage_key: heicKey } = await json<{ storage_key: string }>(heic);
    storage.objects.set(heicKey, { contentType: "image/heic", sizeBytes: 1024 });
    const mismatched = await call(
      w.admin,
      "PUT",
      `/api/staff/${w.teacher.userId}/records/${passport.id}/document`,
      { storage_key: heicKey },
    );
    expect(mismatched.status).toBe(400);

    const staged = await call(w.admin, "POST", "/api/storage/uploads/request-upload", {
      content_class: "staffRecord.sensitiveDocument",
      file_name: "passport.pdf",
      content_type: "application/pdf",
      size_bytes: 1024,
    });
    const { storage_key } = await json<{ storage_key: string }>(staged);
    storage.objects.set(storage_key, { contentType: "application/pdf", sizeBytes: 1024 });
    const attached = await call(
      w.admin,
      "PUT",
      `/api/staff/${w.teacher.userId}/records/${passport.id}/document`,
      { storage_key },
    );
    expect(attached.status).toBe(200);
    expect(storage.sensitiveCopies.some((key) => key.includes(w.schoolId))).toBe(true);

    // The staff member's own read never lists the sensitive document, nor downloads it.
    const own = await json<{ entries: EntryDto[] }>(
      await call(w.teacher, "GET", "/api/me/staff-record"),
    );
    expect(own.entries).toHaveLength(0);
    const ownDownload = await call(
      w.teacher,
      "GET",
      `/api/me/staff-record/${passport.id}/document/download`,
    );
    expect(ownDownload.status).toBe(404);

    const adminDownload = await call(
      w.admin,
      "GET",
      `/api/staff/${w.teacher.userId}/records/${passport.id}/document/download`,
    );
    expect(adminDownload.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Class records
// ---------------------------------------------------------------------------

describeDb("class records", () => {
  test("timetable:manage edits; leadership reads all; the class's teacher reads teacher-visible fields", async () => {
    const w = await world();
    const fields = await classTemplate(w);
    const put = await call(w.principal, "PUT", `/api/classes/${w.classId}/records`, {
      answers: [
        { field_id: fields.busGroup.id, value: "Route 4" },
        { field_id: fields.homeroom.id, value: "Seat Omar near the front" },
      ],
    });
    expect(put.status).toBe(200);

    const adminView = await json<{ entries: EntryDto[] }>(
      await call(w.admin, "GET", `/api/classes/${w.classId}/records`),
    );
    expect(labels(adminView.entries)).toEqual(["Bus group", "Homeroom notes"]);

    const teacherView = await call(w.teacher, "GET", `/api/classes/${w.classId}/records`);
    expect(teacherView.status).toBe(200);
    const teacherBody = await json<{ entries: EntryDto[] }>(teacherView);
    expect(labels(teacherBody.entries)).toEqual(["Bus group"]);
    expect(teacherBody.entries[0]!.value).toBe("Route 4");

    const notTheirs = await call(w.otherTeacher, "GET", `/api/classes/${w.classId}/records`);
    expect(notTheirs.status).toBe(404);

    const teacherWrite = await call(w.teacher, "PUT", `/api/classes/${w.classId}/records`, {
      answers: [{ field_id: fields.busGroup.id, value: "Route 9" }],
    });
    expect(teacherWrite.status).toBe(403);

    for (const who of [w.finance, w.parent]) {
      expect((await call(who, "GET", `/api/classes/${w.classId}/records`)).status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// Missing information
// ---------------------------------------------------------------------------

describeDb("missing information for staff and classes", () => {
  test("staff: ORG_ADMIN sees a missing sensitive field; the principal's list leaves it out", async () => {
    const w = await world();
    const fields = await staffTemplate(w);
    await call(w.admin, "PUT", `/api/staff/${w.teacher.userId}/records`, {
      answers: [{ field_id: fields.qualification.id, value: "BEd" }],
    });

    interface StaffList {
      staff: { user_id: string; missing: { label_en: string }[] }[];
    }
    const adminList = await json<StaffList>(
      await call(w.admin, "GET", "/api/records/missing/staff?issue=missing&limit=100"),
    );
    const teacherRow = adminList.staff.find((row) => row.user_id === w.teacher.userId)!;
    expect(teacherRow.missing.map((field) => field.label_en)).toEqual(["Monthly salary"]);
    // The parent and the student are not staff.
    expect(adminList.staff.some((row) => row.user_id === w.parent.userId)).toBe(false);

    const principalList = await json<StaffList>(
      await call(w.principal, "GET", "/api/records/missing/staff?issue=missing&limit=100"),
    );
    expect(principalList.staff.some((row) => row.user_id === w.teacher.userId)).toBe(false);
    expect(
      principalList.staff.every((row) => row.missing.every((f) => f.label_en !== "Monthly salary")),
    ).toBe(true);

    expect((await call(w.teacher, "GET", "/api/records/missing/staff")).status).toBe(403);
  });

  test("classes: leadership sees the required homeroom notes; a teacher only their classes", async () => {
    const w = await world();
    await classTemplate(w);
    interface ClassList {
      classes: { class_id: string; code: string; missing: unknown[] }[];
    }
    const principalList = await json<ClassList>(
      await call(w.principal, "GET", "/api/records/missing/classes"),
    );
    expect(principalList.classes.map((row) => row.class_id)).toEqual([w.classId]);
    expect(principalList.classes[0]!.code).toBe(w.fixture.cls.code);

    // The teacher's fields are the teacher-visible ones, none of them required: nothing missing.
    const teacherList = await json<ClassList>(
      await call(w.teacher, "GET", "/api/records/missing/classes"),
    );
    expect(teacherList.classes).toEqual([]);
    expect((await call(w.finance, "GET", "/api/records/missing/classes")).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Imported columns kept as record fields
// ---------------------------------------------------------------------------

interface PreviewDto {
  field: { id: string | null; field_type: string; sensitivity: string; options: unknown[] };
  suggested_sensitive: boolean;
  totals: Record<string, number>;
  rows: {
    subject_id: string;
    status: string;
    reason: string | null;
    value: unknown;
    mask: string | null;
  }[];
  preview_token: string;
}

async function importStaff(w: World, name: string): Promise<string> {
  const response = await call(w.admin, "POST", "/api/users", {
    email: `${name.toLowerCase().replace(/\s/g, ".")}-${crypto.randomUUID().slice(0, 6)}@test.local`,
    display_name: name,
    role: ROLES.INSTRUCTOR,
  });
  expect(response.status).toBe(201);
  return (await json<{ id: string }>(response)).id;
}

describeDb("keeping an imported column as a record field", () => {
  test("staff: preview guesses the type, writes nothing, and apply writes only the imported rows", async () => {
    const w = await world();
    const first = await importStaff(w, "Lina Saleh");
    const second = await importStaff(w, "Sami Odeh");
    const body = {
      header: "Contract",
      new_field: { label_en: "Contract", label_ar: "العقد" },
      rows: [
        { line: 2, subject_id: first, value: "Permanent" },
        { line: 3, subject_id: second, value: "Fixed term" },
        // Already on staff before this import: never written, whatever the file says.
        { line: 4, subject_id: w.teacher.userId, value: "Permanent" },
        { line: 5, subject_id: w.parent.userId, value: "Permanent" },
      ],
    };
    const preview = await call(w.admin, "POST", "/api/record-imports/staff/preview", body);
    expect(preview.status).toBe(200);
    const planned = await json<PreviewDto>(preview);
    expect(planned.field.id).toBeNull();
    expect(planned.field.field_type).toBe("short_text");
    expect(planned.totals).toMatchObject({ write: 2, skipped: 2 });
    expect(planned.rows.filter((row) => row.status === "skipped").map((row) => row.reason)).toEqual(
      ["NOT_CREATED_BY_IMPORT", "NOT_CREATED_BY_IMPORT"],
    );

    // Nothing written yet: the template is still unpublished.
    const template = await json<{ published_version: number }>(
      await call(w.admin, "GET", "/api/record-templates/staff"),
    );
    expect(template.published_version).toBe(0);

    const stale = await call(w.admin, "POST", "/api/record-imports/staff/apply", {
      ...body,
      preview_token: "0".repeat(64),
    });
    expect(stale.status).toBe(409);
    expect((await json<{ code: string }>(stale)).code).toBe("IMPORT_COLUMN_PREVIEW_STALE");

    const applied = await call(w.admin, "POST", "/api/record-imports/staff/apply", {
      ...body,
      preview_token: planned.preview_token,
    });
    expect(applied.status).toBe(200);
    const result = await json<{ field_id: string; field_created: boolean; written: number }>(
      applied,
    );
    expect(result).toMatchObject({ field_created: true, written: 2 });

    const record = await json<{ entries: EntryDto[] }>(
      await call(w.admin, "GET", `/api/staff/${first}/records`),
    );
    expect(record.entries.find((e) => e.field.id === result.field_id)!.value).toBe("Permanent");
    const untouched = await json<{ entries: EntryDto[] }>(
      await call(w.admin, "GET", `/api/staff/${w.teacher.userId}/records`),
    );
    expect(untouched.entries.find((e) => e.field.id === result.field_id)!.value).toBeNull();
  });

  test("an ID-like staff column is suggested sensitive, and its preview shows masks only", async () => {
    const w = await world();
    const imported = await importStaff(w, "Huda Nasser");
    const preview = await json<PreviewDto>(
      await call(w.admin, "POST", "/api/record-imports/staff/preview", {
        header: "National ID",
        new_field: { label_en: "National ID", label_ar: "الرقم الوطني" },
        rows: [{ line: 2, subject_id: imported, value: NATIONAL_ID }],
      }),
    );
    expect(preview.suggested_sensitive).toBe(true);
    expect(preview.field.sensitivity).toBe("sensitive");
    expect(preview.rows[0]!.value).toBeNull();
    expect(preview.rows[0]!.mask).not.toBeNull();
    expect(JSON.stringify(preview)).not.toContain(NATIONAL_ID);
  });

  test("class: a principal keeps a column for the classes their import created", async () => {
    const w = await world();
    const created = await call(w.principal, "POST", "/api/academics/classes", {
      course_id: w.fixture.course.id,
      academic_year_id: w.fixture.academicYear.id,
      term_id: w.fixture.term.id,
      lead_teacher_id: w.fixture.teachers[0]!.id,
      room_id: w.fixture.room.id,
      code: `IMP-${crypto.randomUUID().slice(0, 4)}`,
    });
    expect(created.status).toBe(201);
    const classId = (await json<{ id: string }>(created)).id;

    const body = {
      header: "Bus group",
      new_field: { label_en: "Bus group", label_ar: "مجموعة الحافلة", sensitivity: "sensitive" },
      rows: [{ line: 2, subject_id: classId, value: "Route 4" }],
    };
    // A class field cannot be sensitive, whatever the request asks.
    const preview = await json<PreviewDto>(
      await call(w.principal, "POST", "/api/record-imports/class/preview", body),
    );
    expect(preview.field.sensitivity).toBe("standard");
    expect(preview.suggested_sensitive).toBe(false);

    const applied = await call(w.principal, "POST", "/api/record-imports/class/apply", {
      ...body,
      preview_token: preview.preview_token,
    });
    expect(applied.status).toBe(200);
    expect((await json<{ written: number }>(applied)).written).toBe(1);

    // The fixture class was not created by this import.
    const other = await json<PreviewDto>(
      await call(w.principal, "POST", "/api/record-imports/class/preview", {
        ...body,
        rows: [{ line: 2, subject_id: w.classId, value: "Route 1" }],
      }),
    );
    expect(other.totals).toMatchObject({ write: 0, skipped: 1 });
  });

  test("each kind has its own permission; a teacher can do neither", async () => {
    const w = await world();
    const body = {
      header: "Notes",
      new_field: { label_en: "Notes", label_ar: "ملاحظات" },
      rows: [{ line: 2, subject_id: w.teacher.userId, value: "x" }],
    };
    expect(
      (await call(w.principal, "POST", "/api/record-imports/staff/preview", body)).status,
    ).toBe(403);
    expect((await call(w.teacher, "POST", "/api/record-imports/class/preview", body)).status).toBe(
      403,
    );
  });
});
