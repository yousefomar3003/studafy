/**
 * School-defined student and parent records (docs/modules/student-records.md, 000170, ADR-019):
 * the template editor, filling records in, sensitive-value masking and the audited reveal,
 * documents and their content classes, and the missing-information list -- with the permission,
 * row-scope and tenant boundaries around each. Requires a live PostgreSQL instance, gated on
 * TEST_DATABASE_URL.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/records/records-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createStudent,
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
  presigned: { key: string; ttl: number | undefined }[];
} {
  const objects = new Map<string, StoredObject>();
  const sensitiveCopies: string[] = [];
  const presigned: { key: string; ttl: number | undefined }[] = [];
  const base: StorageService = {
    ttlSeconds: 900,
    check: async () => true,
    presign(key, _method, _contentType, ttlOverrideSeconds) {
      presigned.push({ key, ttl: ttlOverrideSeconds });
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
  return Object.assign(base, { objects, sensitiveCopies, presigned });
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
  /** Enrolled in the class the teacher leads; linked to `parent`. */
  studentId: string;
  /** In no class of the teacher's; linked to `otherParent`. */
  otherStudentId: string;
  admin: Actor;
  principal: Actor;
  finance: Actor;
  teacher: Actor;
  parent: Actor;
  otherParent: Actor;
}

const SENSITIVE_ID_VALUE = "P1234567-PASSPORT";

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

async function link(schoolId: string, parentUserId: string, studentId: string) {
  const [family] = await database!.sql<{ id: string }[]>`
    INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
    VALUES (${schoolId}::uuid, 'Family', ${parentUserId}::uuid)
    RETURNING id
  `;
  await database!.sql`
    INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
    VALUES (${schoolId}::uuid, ${family!.id}::uuid, ${parentUserId}::uuid, ${studentId}::uuid, 'mother')
  `;
}

async function world(): Promise<World> {
  const fixture = await createFullTenant(database!.sql);
  const schoolId = fixture.schoolId;
  const principal = await newUser(schoolId, ROLES.PRINCIPAL, "Head Teacher");
  const finance = await newUser(schoolId, ROLES.FINANCE, "Bursar");
  const parent = await newUser(schoolId, ROLES.PARENT, "Rana Haddad");
  const otherParent = await newUser(schoolId, ROLES.PARENT, "Omar Saleh");
  await assignRole(database!.sql, schoolId, fixture.teachers[0]!.userId, ROLES.INSTRUCTOR);
  const other = await createStudent(database!.sql, schoolId, {
    firstName: "Other",
    lastName: "Child",
  });
  await link(schoolId, parent.id, fixture.students[0]!.id);
  await link(schoolId, otherParent.id, other.id);
  return {
    fixture,
    schoolId,
    studentId: fixture.students[0]!.id,
    otherStudentId: other.id,
    admin: actor(schoolId, fixture.users.ORG_ADMIN.id, ROLES.ORG_ADMIN),
    principal: actor(schoolId, principal.id, ROLES.PRINCIPAL),
    finance: actor(schoolId, finance.id, ROLES.FINANCE),
    teacher: actor(schoolId, fixture.teachers[0]!.userId, ROLES.INSTRUCTOR),
    parent: actor(schoolId, parent.id, ROLES.PARENT),
    otherParent: actor(schoolId, otherParent.id, ROLES.PARENT),
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

async function addField(who: Actor, kind: "student" | "parent", body: Record<string, unknown>) {
  const response = await call(who, "POST", `/api/record-templates/${kind}/fields`, {
    label_ar: "حقل",
    ...body,
  });
  expect(response.status).toBe(201);
  return json<FieldDto>(response);
}

async function publish(who: Actor, kind: "student" | "parent" = "student") {
  const response = await call(who, "POST", `/api/record-templates/${kind}/publish`);
  expect(response.status).toBe(201);
  return json<{ version: number }>(response);
}

/** A student template with one field at each visibility, a sensitive ID and a document. */
async function standardTemplate(w: World) {
  const staffOnly = await addField(w.admin, "student", {
    field_type: "short_text",
    label_en: "Previous school",
    required: true,
  });
  const financeField = await addField(w.admin, "student", {
    field_type: "short_text",
    label_en: "Fee sponsor",
    visibility: "finance",
  });
  const teachersField = await addField(w.admin, "student", {
    field_type: "long_text",
    label_en: "Allergies",
    visibility: "teachers",
  });
  const parentField = await addField(w.admin, "student", {
    field_type: "single_choice",
    label_en: "Bus route",
    visibility: "parent",
    options: [
      { value: "red", label_en: "Red", label_ar: "أحمر" },
      { value: "blue", label_en: "Blue", label_ar: "أزرق" },
    ],
  });
  const nationalId = await addField(w.admin, "student", {
    field_type: "short_text",
    label_en: "National ID number",
    sensitivity: "sensitive",
    visibility: "parent",
  });
  const birthCertificate = await addField(w.admin, "student", {
    field_type: "document",
    label_en: "Birth certificate",
    required: true,
    has_expiry: true,
    visibility: "teachers",
  });
  await publish(w.admin);
  return { staffOnly, financeField, teachersField, parentField, nationalId, birthCertificate };
}

async function fill(
  w: World,
  studentId: string,
  fields: Awaited<ReturnType<typeof standardTemplate>>,
) {
  const response = await call(w.admin, "PUT", `/api/students/${studentId}/records`, {
    answers: [
      { field_id: fields.staffOnly.id, value: "Al Noor Primary" },
      { field_id: fields.financeField.id, value: "Grandfather" },
      { field_id: fields.teachersField.id, value: "Peanuts" },
      { field_id: fields.parentField.id, value: "red" },
      { field_id: fields.nationalId.id, value: SENSITIVE_ID_VALUE },
    ],
  });
  expect(response.status).toBe(200);
  return response;
}

interface EntryDto {
  field: { id: string; label_en: string; sensitivity: string };
  value: unknown;
  masked: boolean;
  mask: string | null;
  archived: boolean;
  missing: boolean;
  answered_in_version: number | null;
  answered_field: { label_en: string } | null;
  document: { status: string; sensitive: boolean; expiry_state: string } | null;
}

async function entriesFor(who: Actor, studentId: string) {
  const response = await call(who, "GET", `/api/students/${studentId}/records`);
  return { response, body: response.ok ? await json<{ entries: EntryDto[] }>(response) : null };
}

function labels(entries: EntryDto[]) {
  return entries.map((entry) => entry.field.label_en).sort();
}

async function stage(contentClass: string, contentType: string, sizeBytes: number, who: Actor) {
  const response = await call(who, "POST", "/api/storage/uploads/request-upload", {
    content_class: contentClass,
    file_name: "scan.pdf",
    content_type: contentType,
    size_bytes: Math.min(sizeBytes, 1024),
  });
  if (response.status !== 200 && response.status !== 201) return { response, key: null };
  const { storage_key } = await json<{ storage_key: string }>(response);
  storage.objects.set(storage_key, { contentType, sizeBytes });
  return { response, key: storage_key };
}

// ---------------------------------------------------------------------------
// Template editor
// ---------------------------------------------------------------------------

describeDb("template editor", () => {
  test("ORG_ADMIN and PRINCIPAL build and publish; every other role is refused", async () => {
    const w = await world();
    await addField(w.admin, "student", { field_type: "short_text", label_en: "Bus stop" });
    expect((await publish(w.admin)).version).toBe(1);

    await addField(w.principal, "parent", { field_type: "phone", label_en: "Work phone" });
    expect((await publish(w.principal, "parent")).version).toBe(1);

    const template = await json<{ published_version: number; fields: FieldDto[] }>(
      await call(w.principal, "GET", "/api/record-templates/student"),
    );
    expect(template.published_version).toBe(1);
    expect(template.fields.map((f) => f.label_en)).toEqual(["Bus stop"]);

    for (const who of [w.finance, w.teacher, w.parent]) {
      expect((await call(who, "GET", "/api/record-templates/student")).status).toBe(403);
      expect(
        (
          await call(who, "POST", "/api/record-templates/student/fields", {
            field_type: "short_text",
            label_en: "x",
            label_ar: "x",
          })
        ).status,
      ).toBe(403);
      expect((await call(who, "POST", "/api/record-templates/student/publish")).status).toBe(403);
    }
  });

  test("publishing with no changes is refused", async () => {
    const w = await world();
    await addField(w.admin, "student", { field_type: "short_text", label_en: "Bus stop" });
    await publish(w.admin);
    const again = await call(w.admin, "POST", "/api/record-templates/student/publish");
    expect(again.status).toBe(409);
  });

  test("labels that read like an ID or medical information are flagged as a hint", async () => {
    const w = await world();
    const field = await addField(w.admin, "student", {
      field_type: "short_text",
      label_en: "Passport number",
    });
    expect(
      (field as unknown as { label_suggests_sensitive: boolean }).label_suggests_sensitive,
    ).toBe(true);
  });

  test("a published field's type and a sensitive field's sensitivity are locked", async () => {
    const w = await world();
    const field = await addField(w.admin, "student", {
      field_type: "short_text",
      label_en: "Civil ID",
      sensitivity: "sensitive",
    });
    await publish(w.admin);
    const path = `/api/record-templates/student/fields/${field.id}`;
    expect((await call(w.admin, "PATCH", path, { field_type: "number" })).status).toBe(409);
    expect((await call(w.admin, "PATCH", path, { sensitivity: "standard" })).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Visibility, row scope and tenant isolation
// ---------------------------------------------------------------------------

describeDb("who reads what", () => {
  test("each role reads exactly the fields and the students it may", async () => {
    const w = await world();
    const fields = await standardTemplate(w);
    await fill(w, w.studentId, fields);

    const staff = await entriesFor(w.admin, w.studentId);
    expect(labels(staff.body!.entries)).toEqual(
      [
        "Allergies",
        "Birth certificate",
        "Bus route",
        "Fee sponsor",
        "National ID number",
        "Previous school",
      ].sort(),
    );

    // Finance: finance-or-wider, never sensitive.
    const finance = await entriesFor(w.finance, w.studentId);
    expect(finance.response.status).toBe(200);
    expect(labels(finance.body!.entries)).toEqual(
      ["Allergies", "Birth certificate", "Bus route", "Fee sponsor"].sort(),
    );

    // A teacher of the student: teachers-or-wider, never sensitive.
    const teacher = await entriesFor(w.teacher, w.studentId);
    expect(labels(teacher.body!.entries)).toEqual(
      ["Allergies", "Birth certificate", "Bus route"].sort(),
    );

    // The student's parent: parent-visible, never sensitive.
    const parent = await entriesFor(w.parent, w.studentId);
    expect(labels(parent.body!.entries)).toEqual(["Bus route"]);
    expect(parent.body!.entries[0]!.value).toBe("red");

    // Outside their scope: the same 404 as a student who does not exist.
    expect((await entriesFor(w.teacher, w.otherStudentId)).response.status).toBe(404);
    expect((await entriesFor(w.otherParent, w.studentId)).response.status).toBe(404);
    expect((await call(w.teacher, "GET", `/api/parents/${w.parent.userId}/records`)).status).toBe(
      404,
    );
    expect((await call(w.parent, "GET", `/api/parents/${w.parent.userId}/records`)).status).toBe(
      404,
    );
  });

  test("only leadership writes; parents enter nothing", async () => {
    const w = await world();
    const fields = await standardTemplate(w);
    for (const who of [w.finance, w.teacher, w.parent]) {
      const response = await call(who, "PUT", `/api/students/${w.studentId}/records`, {
        answers: [{ field_id: fields.parentField.id, value: "blue" }],
      });
      expect(response.status).toBe(403);
    }
    const principal = await call(w.principal, "PUT", `/api/students/${w.studentId}/records`, {
      answers: [{ field_id: fields.parentField.id, value: "blue" }],
    });
    expect(principal.status).toBe(200);
  });

  test("another school sees nothing of this school's records", async () => {
    const w = await world();
    const fields = await standardTemplate(w);
    await fill(w, w.studentId, fields);
    const elsewhere = await world();

    expect((await entriesFor(elsewhere.admin, w.studentId)).response.status).toBe(404);
    expect(
      (
        await call(
          elsewhere.admin,
          "POST",
          `/api/students/${w.studentId}/records/${fields.nationalId.id}/reveal`,
        )
      ).status,
    ).toBe(404);
    const theirTemplate = await json<{ fields: unknown[] }>(
      await call(elsewhere.admin, "GET", "/api/record-templates/student"),
    );
    expect(theirTemplate.fields).toEqual([]);
    // And a write naming another school's field is refused.
    const write = await call(
      elsewhere.admin,
      "PUT",
      `/api/students/${elsewhere.studentId}/records`,
      {
        answers: [{ field_id: fields.staffOnly.id, value: "x" }],
      },
    );
    expect([404, 409]).toContain(write.status);
  });
});

// ---------------------------------------------------------------------------
// Sensitive values
// ---------------------------------------------------------------------------

describeDb("sensitive values", () => {
  test("masked in every non-reveal response, sealed at rest, never in an audit row", async () => {
    const w = await world();
    const fields = await standardTemplate(w);
    const write = await fill(w, w.studentId, fields);
    expect(await write.clone().text()).not.toContain(SENSITIVE_ID_VALUE);

    const staff = await call(w.admin, "GET", `/api/students/${w.studentId}/records`);
    const text = await staff.text();
    expect(text).not.toContain(SENSITIVE_ID_VALUE);
    expect(staff.headers.get("Cache-Control")).toBe("no-store");
    const id = (JSON.parse(text) as { entries: EntryDto[] }).entries.find(
      (entry) => entry.field.id === fields.nationalId.id,
    )!;
    expect(id).toMatchObject({ value: null, masked: true, mask: "•••• PORT" });

    for (const path of [
      "/api/records/missing/students",
      "/api/records/missing/summary",
      "/api/record-templates/student",
    ]) {
      expect(await (await call(w.admin, "GET", path)).text()).not.toContain(SENSITIVE_ID_VALUE);
    }

    const [stored] = await database!.sql<
      { value: unknown; value_ciphertext: Uint8Array; value_mask: string }[]
    >`
      SELECT value, value_ciphertext, value_mask FROM app.record_answers
      WHERE school_id = ${w.schoolId}::uuid AND field_id = ${fields.nationalId.id}::uuid
    `;
    expect(stored!.value).toBeNull();
    expect(Buffer.from(stored!.value_ciphertext).toString("utf8")).not.toContain(
      SENSITIVE_ID_VALUE,
    );

    const audits = await database!.sql<{ payload: string }[]>`
      SELECT coalesce(old_values::text, '') || coalesce(new_values::text, '') AS payload
      FROM app.audit_logs
      WHERE school_id = ${w.schoolId}::uuid AND target_table = 'record_answers'
    `;
    expect(audits.length).toBeGreaterThan(0);
    for (const row of audits) expect(row.payload).not.toContain(SENSITIVE_ID_VALUE);
  });

  test("reveal returns the value to ORG_ADMIN and PRINCIPAL, audited with who and which field", async () => {
    const w = await world();
    const fields = await standardTemplate(w);
    await fill(w, w.studentId, fields);
    const path = `/api/students/${w.studentId}/records/${fields.nationalId.id}/reveal`;

    for (const who of [w.admin, w.principal]) {
      const response = await call(who, "POST", path);
      expect(response.status).toBe(200);
      expect(await json<{ field_id: string; value: unknown }>(response)).toEqual({
        field_id: fields.nationalId.id,
        value: SENSITIVE_ID_VALUE,
      });
      const [audit] = await database!.sql<
        { actor_id: string; new_values: Record<string, unknown> }[]
      >`
        SELECT actor_id, new_values FROM app.audit_logs
        WHERE school_id = ${w.schoolId}::uuid AND action = 'read' AND actor_id = ${who.userId}::uuid
        ORDER BY created_at DESC LIMIT 1
      `;
      expect(audit!.new_values).toMatchObject({ field_id: fields.nationalId.id, reveal: true });
      expect(JSON.stringify(audit!.new_values)).not.toContain(SENSITIVE_ID_VALUE);
    }

    for (const who of [w.finance, w.teacher, w.parent]) {
      expect((await call(who, "POST", path)).status).toBe(403);
    }
    // A standard field is not revealed: the read already returns it.
    expect(
      (
        await call(
          w.admin,
          "POST",
          `/api/students/${w.studentId}/records/${fields.staffOnly.id}/reveal`,
        )
      ).status,
    ).toBe(409);
  });

  test("raising a field to sensitive seals its existing answers at publish", async () => {
    const w = await world();
    const field = await addField(w.admin, "student", {
      field_type: "short_text",
      label_en: "Notes",
    });
    await publish(w.admin);
    await call(w.admin, "PUT", `/api/students/${w.studentId}/records`, {
      answers: [{ field_id: field.id, value: "diabetic, insulin at lunch" }],
    });
    await call(w.admin, "PATCH", `/api/record-templates/student/fields/${field.id}`, {
      sensitivity: "sensitive",
    });
    await publish(w.admin);
    const [stored] = await database!.sql<{ value: unknown; value_mask: string }[]>`
      SELECT value, value_mask FROM app.record_answers
      WHERE school_id = ${w.schoolId}::uuid AND field_id = ${field.id}::uuid
    `;
    expect(stored).toMatchObject({ value: null, value_mask: "•••• unch" });
  });
});

// ---------------------------------------------------------------------------
// Versions and archiving
// ---------------------------------------------------------------------------

describeDb("template changes never rewrite or delete answers", () => {
  test("a new version keeps old answers pointing at the field they were given for", async () => {
    const w = await world();
    const field = await addField(w.admin, "student", {
      field_type: "single_choice",
      label_en: "Bus route",
      options: [{ value: "red", label_en: "Red", label_ar: "أحمر" }],
    });
    await publish(w.admin);
    await call(w.admin, "PUT", `/api/students/${w.studentId}/records`, {
      answers: [{ field_id: field.id, value: "red" }],
    });
    const [before] = await database!.sql<{ field_version_id: string }[]>`
      SELECT field_version_id FROM app.record_answers WHERE field_id = ${field.id}::uuid
    `;

    await call(w.admin, "PATCH", `/api/record-templates/student/fields/${field.id}`, {
      label_en: "Morning bus",
      options: [{ value: "green", label_en: "Green", label_ar: "أخضر" }],
    });
    expect((await publish(w.admin)).version).toBe(2);

    const [after] = await database!.sql<{ field_version_id: string; value: unknown }[]>`
      SELECT field_version_id, value FROM app.record_answers WHERE field_id = ${field.id}::uuid
    `;
    expect(after).toEqual({ field_version_id: before!.field_version_id, value: "red" });

    const entry = (await entriesFor(w.admin, w.studentId)).body!.entries[0]!;
    expect(entry.field.label_en).toBe("Morning bus");
    expect(entry.value).toBe("red");
    expect(entry.answered_in_version).toBe(1);
    expect(entry.answered_field?.label_en).toBe("Bus route");
  });

  test("archiving a field drops it from the form and keeps its answers", async () => {
    const w = await world();
    const field = await addField(w.admin, "student", {
      field_type: "short_text",
      label_en: "Locker",
      visibility: "teachers",
    });
    await publish(w.admin);
    await call(w.admin, "PUT", `/api/students/${w.studentId}/records`, {
      answers: [{ field_id: field.id, value: "B-12" }],
    });
    await call(w.admin, "PATCH", `/api/record-templates/student/fields/${field.id}`, {
      archived: true,
    });
    await publish(w.admin);

    const [{ count }] = (await database!.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.record_answers WHERE field_id = ${field.id}::uuid
    `) as unknown as [{ count: number }];
    expect(count).toBe(1);

    const staff = (await entriesFor(w.admin, w.studentId)).body!.entries;
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ archived: true, value: "B-12" });
    expect((await entriesFor(w.teacher, w.studentId)).body!.entries).toEqual([]);

    // A write to it is refused now that it is off the form.
    const write = await call(w.admin, "PUT", `/api/students/${w.studentId}/records`, {
      answers: [{ field_id: field.id, value: "C-1" }],
    });
    expect(write.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

describeDb("documents", () => {
  test("upload, verify and download through the record.document content class", async () => {
    const w = await world();
    const fields = await standardTemplate(w);
    const base = `/api/students/${w.studentId}/records/${fields.birthCertificate.id}/document`;

    // Content class enforcement at request-upload: permission and type.
    expect(
      (await stage("record.document", "application/pdf", 2048, w.teacher)).response.status,
    ).toBe(403);
    expect((await stage("record.document", "text/plain", 2048, w.admin)).response.status).toBe(400);

    const { key } = await stage("record.document", "application/pdf", 2048, w.admin);
    const attached = await call(w.admin, "PUT", base, {
      storage_key: key,
      expires_on: "2020-01-01",
    });
    expect(attached.status).toBe(200);
    const entry = (await json<{ entries: EntryDto[] }>(attached)).entries.find(
      (e) => e.field.id === fields.birthCertificate.id,
    )!;
    expect(entry.document).toMatchObject({
      status: "uploaded",
      sensitive: false,
      expiry_state: "expired",
    });
    expect(entry.missing).toBe(false);

    const verified = await call(w.admin, "PATCH", base, { status: "verified" });
    expect(verified.status).toBe(200);
    const [row] = await database!.sql<{ status: string; verified_by: string }[]>`
      SELECT status, verified_by FROM app.record_documents WHERE school_id = ${w.schoolId}::uuid
    `;
    expect(row).toEqual({ status: "verified", verified_by: w.admin.userId });

    // The teacher may read a teachers-visible document; a parent may not.
    expect((await call(w.teacher, "GET", `${base}/download`)).status).toBe(200);
    expect((await call(w.parent, "GET", `${base}/download`)).status).toBe(404);

    expect((await call(w.admin, "DELETE", base)).status).toBe(204);
    const after = (await entriesFor(w.admin, w.studentId)).body!.entries.find(
      (e) => e.field.id === fields.birthCertificate.id,
    )!;
    expect(after.document?.status).toBe("missing");
    expect(after.missing).toBe(true);
  });

  test("a sensitive document needs the stricter class, the KMS copy, and a one-minute audited URL", async () => {
    const w = await world();
    const passport = await addField(w.admin, "student", {
      field_type: "document",
      label_en: "Passport scan",
      sensitivity: "sensitive",
    });
    await publish(w.admin);
    const base = `/api/students/${w.studentId}/records/${passport.id}/document`;

    // Staged under the ordinary class: the stored object is checked against the stricter one.
    const big = await stage(
      "record.sensitiveDocument",
      "application/pdf",
      8 * 1024 * 1024,
      w.admin,
    );
    expect((await call(w.admin, "PUT", base, { storage_key: big.key })).status).toBe(400);
    const heic = await stage("record.document", "image/heic", 2048, w.admin);
    expect((await call(w.admin, "PUT", base, { storage_key: heic.key })).status).toBe(400);

    const { key } = await stage("record.sensitiveDocument", "application/pdf", 2048, w.admin);
    expect((await call(w.admin, "PUT", base, { storage_key: key })).status).toBe(200);
    expect(
      storage.sensitiveCopies.some((dest) => dest.startsWith(`permanent/${w.schoolId}/`)),
    ).toBe(true);

    const download = await call(w.principal, "GET", `${base}/download`);
    expect(download.status).toBe(200);
    expect(storage.presigned.at(-1)?.ttl).toBe(60);
    const [audit] = await database!.sql<{ new_values: Record<string, unknown> }[]>`
      SELECT new_values FROM app.audit_logs
      WHERE school_id = ${w.schoolId}::uuid AND action = 'read' AND target_table = 'record_documents'
    `;
    expect(audit!.new_values).toMatchObject({ field_id: passport.id, reveal: true });

    expect((await call(w.finance, "GET", `${base}/download`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Missing information
// ---------------------------------------------------------------------------

describeDb("missing information", () => {
  test("lists missing required fields and expired documents, within the caller's scope", async () => {
    const w = await world();
    const fields = await standardTemplate(w);
    await fill(w, w.studentId, fields);
    const { key } = await stage("record.document", "application/pdf", 2048, w.admin);
    await call(
      w.admin,
      "PUT",
      `/api/students/${w.studentId}/records/${fields.birthCertificate.id}/document`,
      {
        storage_key: key,
        expires_on: "2020-01-01",
      },
    );

    interface MissingList {
      students: { student_id: string; missing: FieldDto[]; expired: FieldDto[] }[];
      total: number;
      issue: string | null;
    }
    const all = await json<MissingList>(
      await call(w.admin, "GET", "/api/records/missing/students"),
    );
    const filled = all.students.find((s) => s.student_id === w.studentId)!;
    expect(filled.missing).toEqual([]);
    expect(filled.expired.map((f) => f.label_en)).toEqual(["Birth certificate"]);
    const empty = all.students.find((s) => s.student_id === w.otherStudentId)!;
    expect(empty.missing.map((f) => f.label_en)).toEqual(["Previous school", "Birth certificate"]);

    const expiredOnly = await json<MissingList>(
      await call(w.principal, "GET", "/api/records/missing/students?issue=expired"),
    );
    expect(expiredOnly.issue).toBe("expired");
    expect(expiredOnly.students.map((s) => s.student_id)).toEqual([w.studentId]);

    const search = await json<MissingList>(
      await call(w.admin, "GET", "/api/records/missing/students?search=Other"),
    );
    expect(search.students.map((s) => s.student_id)).toEqual([w.otherStudentId]);

    // A teacher sees only their own students, and only teacher-visible fields.
    const teacher = await json<MissingList>(
      await call(w.teacher, "GET", "/api/records/missing/students"),
    );
    expect(teacher.students.map((s) => s.student_id)).toEqual([w.studentId]);
    expect(teacher.students[0]!.missing).toEqual([]);

    const summary = await json<Record<string, number>>(
      await call(w.admin, "GET", "/api/records/missing/summary"),
    );
    expect(summary).toMatchObject({ students: 2, expired_documents: 1 });

    expect((await call(w.parent, "GET", "/api/records/missing/parents")).status).toBe(200);
    expect(
      (
        await json<{ parents: unknown[] }>(
          await call(w.parent, "GET", "/api/records/missing/parents"),
        )
      ).parents,
    ).toEqual([]);
  });

  test("a missing required field never blocks creating or enrolling a student", async () => {
    const w = await world();
    await standardTemplate(w);
    const response = await call(w.admin, "POST", "/api/students", {
      admission_number: `ADM-${crypto.randomUUID().slice(0, 6)}`,
      first_name: "New",
      last_name: "Pupil",
    });
    expect(response.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Records on creation
// ---------------------------------------------------------------------------

describeDb("filling a record while creating the account", () => {
  test("a new student and its record commit together; a bad answer rolls both back", async () => {
    const w = await world();
    const fields = await standardTemplate(w);
    const admission = `ADM-${crypto.randomUUID().slice(0, 6)}`;
    const created = await call(w.admin, "POST", "/api/students", {
      admission_number: admission,
      first_name: "Layla",
      last_name: "Nasser",
      records: [
        { field_id: fields.parentField.id, value: "blue" },
        { field_id: fields.nationalId.id, value: SENSITIVE_ID_VALUE },
      ],
    });
    expect(created.status).toBe(201);
    const { id } = await json<{ id: string }>(created);
    const entries = (await entriesFor(w.admin, id)).body!.entries;
    expect(entries.find((e) => e.field.id === fields.parentField.id)!.value).toBe("blue");
    expect(entries.find((e) => e.field.id === fields.nationalId.id)).toMatchObject({
      masked: true,
      value: null,
    });

    const rejected = await call(w.admin, "POST", "/api/students", {
      admission_number: `ADM-${crypto.randomUUID().slice(0, 6)}`,
      first_name: "Bad",
      last_name: "Answer",
      records: [{ field_id: fields.parentField.id, value: "purple" }],
    });
    expect(rejected.status).toBe(422);
    const [{ count }] = (await database!.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.students
      WHERE school_id = ${w.schoolId}::uuid AND first_name = 'Bad'
    `) as unknown as [{ count: number }];
    expect(count).toBe(0);

    // A principal fills records in but never creates people.
    const principal = await call(w.principal, "POST", "/api/students", {
      admission_number: `ADM-${crypto.randomUUID().slice(0, 6)}`,
      first_name: "No",
      last_name: "Create",
    });
    expect(principal.status).toBe(403);
  });

  test("a new parent and its record commit together", async () => {
    const w = await world();
    const phone = await addField(w.admin, "parent", {
      field_type: "phone",
      label_en: "Work phone",
      visibility: "finance",
    });
    await publish(w.admin, "parent");
    const created = await call(w.admin, "POST", "/api/users", {
      email: `parent-${crypto.randomUUID().slice(0, 8)}@test.local`,
      display_name: "Huda Karim",
      role: "PARENT",
      records: [{ field_id: phone.id, value: "+971 50 123 4567" }],
    });
    expect(created.status).toBe(201);
    const { id } = await json<{ id: string }>(created);
    const records = await json<{ entries: EntryDto[] }>(
      await call(w.finance, "GET", `/api/parents/${id}/records`),
    );
    expect(records.entries.map((e) => e.value)).toEqual(["+971 50 123 4567"]);

    const notParent = await call(w.admin, "POST", "/api/users", {
      email: `teacher-${crypto.randomUUID().slice(0, 8)}@test.local`,
      display_name: "Not A Parent",
      role: "INSTRUCTOR",
      records: [{ field_id: phone.id, value: "+971 50 123 4567" }],
    });
    expect(notParent.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Rewrites: every second write is an audited update
// ---------------------------------------------------------------------------

describeDb("updates are audited like the first write", () => {
  test("re-saving a sensitive value, reordering, and replacing a document", async () => {
    const w = await world();
    const fields = await standardTemplate(w);
    await fill(w, w.studentId, fields);
    const again = await call(w.admin, "PUT", `/api/students/${w.studentId}/records`, {
      answers: [{ field_id: fields.nationalId.id, value: "Q7654321-OTHER" }],
    });
    expect(again.status).toBe(200);
    const reveal = await call(
      w.admin,
      "POST",
      `/api/students/${w.studentId}/records/${fields.nationalId.id}/reveal`,
    );
    expect((await json<{ value: string }>(reveal)).value).toBe("Q7654321-OTHER");

    const order = await call(w.admin, "PUT", "/api/record-templates/student/field-order", {
      field_ids: [fields.birthCertificate.id, fields.staffOnly.id],
    });
    expect(order.status).toBe(200);
    const template = await json<{ fields: FieldDto[] }>(order);
    expect(template.fields.slice(0, 2).map((f) => f.id)).toEqual([
      fields.birthCertificate.id,
      fields.staffOnly.id,
    ]);

    const base = `/api/students/${w.studentId}/records/${fields.birthCertificate.id}/document`;
    const first = await stage("record.document", "application/pdf", 2048, w.admin);
    expect((await call(w.admin, "PUT", base, { storage_key: first.key })).status).toBe(200);
    const second = await stage("record.document", "image/png", 4096, w.admin);
    expect((await call(w.admin, "PUT", base, { storage_key: second.key })).status).toBe(200);
    // The replaced file is gone from the bucket once the write committed.
    const keys = [...storage.objects.keys()].filter((key) =>
      key.startsWith(`permanent/${w.schoolId}/`),
    );
    expect(keys).toHaveLength(1);
  });
});
