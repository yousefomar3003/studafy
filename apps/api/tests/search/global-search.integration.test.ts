/**
 * Global search across all twenty types -- live-PostgreSQL integration test (migration 000170).
 *
 * Runs the real app (real JWT verification, real tenant transactions as studafy_app) against two
 * seeded schools and asserts, per section:
 *   - the role that holds the list endpoint's permission finds the row;
 *   - a role without it gets an empty array and a zero total, even when the row matches;
 *   - row scope holds inside a permitted section (a teacher's classes and students, a parent's own
 *     family and child, an evaluator's own evaluations, a caller's own notifications);
 *   - school B's rows never reach school A;
 * plus matching (prefix, hyphenated document numbers, Arabic normalization both ways, the trigram
 * typo fallback), the `types` filter, `offset` and `totals`, and that a school-defined record answer
 * is never found. It lives under tests/ rather than next to the module because it seeds a record
 * answer directly into the record tables, which source under src/modules/search may never name
 * (tests/records/record-data-boundary.test.ts).
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/search/global-search.integration.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { SEARCH_TRIGRAM_FLOOR } from "../../src/modules/search/service";
import {
  assignRole,
  authenticatedRequest,
  createClass,
  createCourse,
  createDisciplineIncident,
  createEnrollment,
  createFullTenant,
  createStudent,
  createSubject,
  createTeacher,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TenantFixture, TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

const SEARCH_TYPES = [
  "students",
  "users",
  "invoices",
  "materials",
  "classes",
  "sections",
  "subjects",
  "grade_levels",
  "academic_years",
  "terms",
  "rooms",
  "families",
  "announcements",
  "events",
  "incidents",
  "evaluations",
  "fee_structures",
  "scholarships",
  "expenses",
  "notifications",
] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

interface Hit {
  id: string;
  [key: string]: unknown;
}

interface SearchBody {
  query: string;
  types: SearchType[];
  results: Record<SearchType, Hit[]>;
  totals: Record<SearchType, number>;
}

let database: TestDatabase | undefined;
let harness: (TestApp & { ready: Promise<void> }) | undefined;
let a: TenantFixture;
let b: TenantFixture;

/** Every id seeded in school A that a section should be able to find, by type. */
const ids = {} as Record<
  | "omar"
  | "ahmad"
  | "amina"
  | "bartholomew"
  | "brightwater"
  | "brightwatter"
  | "zephyrClass"
  | "teacherClass"
  | "section"
  | "gradeLevel"
  | "room"
  | "ownFamily"
  | "otherFamily"
  | "announcement"
  | "event"
  | "incident"
  | "evaluation"
  | "feeStructure"
  | "scholarship"
  | "expense"
  | "invoice"
  | "adminNotification"
  | "principalNotification"
  | "recordStudent"
  | "subject"
  | "teacherUser",
  string
>;
const people = {} as Record<"principal" | "finance" | "attendance", string>;
const pagetestIds: string[] = [];

/** Seed a row the way the harness factories do: tenant GUC first, then studafy_admin. */
async function seed<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await database!.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    result = await fn(tx);
  });
  return result as T;
}

async function search(
  tenant: TenantFixture,
  userId: string,
  roles: Role[],
  query: string,
  extra = "",
): Promise<{ status: number; body: SearchBody }> {
  const res = await authenticatedRequest(
    harness!,
    "GET",
    `/api/search?q=${encodeURIComponent(query)}${extra}`,
    { schoolId: tenant.schoolId, userId, roles, channel: "web" },
  );
  return { status: res.status, body: (await res.json()) as SearchBody };
}

function idsOf(body: SearchBody, type: SearchType): string[] {
  return body.results[type].map((hit) => hit.id);
}

async function seedSchoolA(): Promise<void> {
  const schoolId = a.schoolId;
  const admin = a.users.ORG_ADMIN.id;

  for (const [role, key] of [
    ["PRINCIPAL", "principal"],
    ["FINANCE", "finance"],
    ["ATTENDANCE_OFFICER", "attendance"],
  ] as const) {
    const user = await createUser(database!.sql, schoolId, { displayName: `${role} Person` });
    await assignRole(database!.sql, schoolId, user.id, role);
    people[key] = user.id;
  }

  ids.omar = (
    await createStudent(database!.sql, schoolId, { firstName: "Omar", lastName: "Haddad" })
  ).id;
  ids.ahmad = (
    await createStudent(database!.sql, schoolId, { firstName: "احمد", lastName: "سالم" })
  ).id;
  ids.amina = (
    await createStudent(database!.sql, schoolId, { firstName: "أمينة", lastName: "نور" })
  ).id;
  ids.bartholomew = (
    await createStudent(database!.sql, schoolId, {
      firstName: "Bartholomew",
      lastName: "Quinterro",
    })
  ).id;
  for (let index = 0; index < 7; index += 1) {
    const student = await createStudent(database!.sql, schoolId, {
      firstName: `Page${String.fromCharCode(97 + index)}`,
      lastName: "Pagetest",
    });
    pagetestIds.push(student.id);
  }
  ids.recordStudent = a.students[0]!.id;

  // The fixture's lead teacher teaches a.cls; a second teacher's "Zephyr" class is outside that
  // teacher's row scope.
  const teacher = a.teachers[0]!;
  ids.teacherClass = a.cls.id;
  ids.teacherUser = teacher.userId;
  await seed(
    schoolId,
    (tx) => tx`UPDATE app.users SET display_name = 'Marlowe Teacher' WHERE id = ${teacher.userId}`,
  );
  const otherTeacher = await createTeacher(database!.sql, schoolId);
  const subject = await createSubject(database!.sql, schoolId, {
    code: "ASTR-1",
    name: "Astronomy",
  });
  ids.subject = subject.id;
  const course = await createCourse(database!.sql, schoolId, subject.id, {
    code: "ASTR-101",
    name: "Stargazing",
  });
  ids.zephyrClass = (
    await createClass(database!.sql, schoolId, {
      courseId: course.id,
      academicYearId: a.academicYear.id,
      termId: a.term.id,
      leadTeacherId: otherTeacher.id,
      roomId: a.room.id,
      code: "ZEPHYR-9",
    })
  ).id;
  await createEnrollment(database!.sql, schoolId, ids.zephyrClass, ids.omar);
  // Typo-fallback scope: Brightwater is in the fixture teacher's class; Brightwatter -- one letter
  // apart, trigram-similar -- only in the Zephyr class that teacher does not teach.
  ids.brightwater = (
    await createStudent(database!.sql, schoolId, { firstName: "Thaddeus", lastName: "Brightwater" })
  ).id;
  await createEnrollment(database!.sql, schoolId, a.cls.id, ids.brightwater);
  ids.brightwatter = (
    await createStudent(database!.sql, schoolId, {
      firstName: "Ottoline",
      lastName: "Brightwatter",
    })
  ).id;
  await createEnrollment(database!.sql, schoolId, ids.zephyrClass, ids.brightwatter);

  await seed(schoolId, async (tx) => {
    const [currency] = await tx<{ id: string }[]>`
      SELECT default_currency_id AS id FROM app.schools WHERE id = ${schoolId}
    `;
    const currencyId = currency!.id;

    const [grade] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_levels (school_id, name, sort_order)
      VALUES (${schoolId}, 'Grade Nebula', 1) RETURNING id
    `;
    ids.gradeLevel = grade!.id;
    const [section] = await tx<{ id: string }[]>`
      INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
      VALUES (${schoolId}, ${a.academicYear.id}, ${grade!.id}, 'Corvid') RETURNING id
    `;
    ids.section = section!.id;

    const [room] = await tx<{ id: string }[]>`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
      VALUES (${schoolId}, 'ORI-1', 'Orion Lab', 'physical', 20, 'North Wing') RETURNING id
    `;
    ids.room = room!.id;

    // The PARENT fixture user heads the Halvorsen family and is linked to the primary student.
    const [own] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}, 'Halvorsen Family', ${a.users.PARENT.id}) RETURNING id
    `;
    ids.ownFamily = own!.id;
    await tx`
      INSERT INTO app.parent_child_links (school_id, parent_user_id, student_id, relationship, family_id)
      VALUES (${schoolId}, ${a.users.PARENT.id}, ${a.students[0]!.id}, 'guardian', ${own!.id})
    `;
    const [other] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}, 'Brightwater Family', ${people.finance}) RETURNING id
    `;
    ids.otherFamily = other!.id;

    const [announcement] = await tx<{ id: string }[]>`
      INSERT INTO app.announcements
        (school_id, created_by, title, body, mandatory, audience_type, status, scheduled_at, published_at)
      VALUES (${schoolId}, ${admin}, 'Quokka Festival', 'Body text', false, 'school', 'published', now(), now())
      RETURNING id
    `;
    ids.announcement = announcement!.id;

    const [event] = await tx<{ id: string }[]>`
      INSERT INTO app.school_events (school_id, created_by, title, description, kind, starts_on, ends_on)
      VALUES (${schoolId}, ${admin}, 'Quokka Parade', 'Secretive description', 'event', '2026-05-01', '2026-05-02')
      RETURNING id
    `;
    ids.event = event!.id;

    const [fee] = await tx<{ id: string }[]>`
      INSERT INTO app.fee_structure_cache
        (school_id, academic_year_id, currency_id, erpnext_docname, erpnext_status, title,
         total_amount_minor, is_active, erpnext_payload, last_synced_at)
      VALUES (${schoolId}, ${a.academicYear.id}, ${currencyId}, 'FS-QUOKKA-01', 'submitted',
              'Quokka Tuition', 250000, true, '{}'::jsonb, now())
      RETURNING id
    `;
    ids.feeStructure = fee!.id;

    const [scholarship] = await tx<{ id: string }[]>`
      INSERT INTO app.scholarships (school_id, name, discount_type, percentage, is_active, created_by)
      VALUES (${schoolId}, 'Quokka Merit', 'percentage', 15, true, ${admin}) RETURNING id
    `;
    ids.scholarship = scholarship!.id;

    const [expense] = await tx<{ id: string }[]>`
      INSERT INTO app.expense_cache
        (school_id, document_type, category, vendor, description, currency_id, amount_minor,
         erpnext_docname, erpnext_status, attachment_storage_key, erpnext_payload, expense_date,
         last_synced_at)
      VALUES (${schoolId}, 'purchase_invoice', 'Stationery', 'Quokka Supplies', 'private note',
              ${currencyId}, 4200, 'PINV-0042', 'Paid', 'permanent/secret/key.pdf', '{}'::jsonb,
              '2026-03-01', now())
      RETURNING id
    `;
    ids.expense = expense!.id;

    const [invoice] = await tx<{ id: string }[]>`
      INSERT INTO app.invoice_cache
        (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
         total_amount_minor, outstanding_amount_minor, issued_date, last_synced_at)
      VALUES (${schoolId}, ${ids.omar}, ${currencyId}, 'INV-0012', 'submitted', 1000, 1000,
              '2026-01-01', now())
      RETURNING id
    `;
    ids.invoice = invoice!.id;

    const [adminNote] = await tx<{ id: string }[]>`
      INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
      VALUES (${schoolId}, ${admin}, 'ADMIN_ANNOUNCEMENT', 'Quokka report ready', 'b', '{}'::jsonb)
      RETURNING id
    `;
    ids.adminNotification = adminNote!.id;
    const [principalNote] = await tx<{ id: string }[]>`
      INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
      VALUES (${schoolId}, ${people.principal}, 'ADMIN_ANNOUNCEMENT', 'Quokka other inbox', 'b', '{}'::jsonb)
      RETURNING id
    `;
    ids.principalNotification = principalNote!.id;

    // A school-defined student record answer whose value is a word nothing else contains. It must
    // never be found by any section.
    const [template] = await tx<{ id: string }[]>`
      INSERT INTO app.record_templates (school_id, subject_kind, published_version)
      VALUES (${schoolId}, 'student', 1) RETURNING id
    `;
    const [field] = await tx<{ id: string }[]>`
      INSERT INTO app.record_fields
        (school_id, template_id, field_type, label_en, label_ar, visibility, created_by)
      VALUES (${schoolId}, ${template!.id}, 'short_text', 'Allergy notes', 'ملاحظات', 'teachers', ${admin})
      RETURNING id
    `;
    const [version] = await tx<{ id: string }[]>`
      INSERT INTO app.record_template_versions (school_id, template_id, version, published_by)
      VALUES (${schoolId}, ${template!.id}, 1, ${admin}) RETURNING id
    `;
    const [fieldVersion] = await tx<{ id: string }[]>`
      INSERT INTO app.record_field_versions
        (school_id, template_version_id, field_id, field_type, label_en, label_ar, required,
         options, sort_order, visibility, sensitivity, has_expiry)
      VALUES (${schoolId}, ${version!.id}, ${field!.id}, 'short_text', 'Allergy notes', 'ملاحظات',
              false, '[]'::jsonb, 0, 'teachers', 'standard', false)
      RETURNING id
    `;
    await tx`
      INSERT INTO app.record_answers
        (school_id, subject_kind, student_id, field_id, field_version_id, value, updated_by)
      VALUES (${schoolId}, 'student', ${ids.recordStudent}, ${field!.id}, ${fieldVersion!.id},
              '"Xylophonia peanut"'::jsonb, ${admin})
    `;
  });

  ids.incident = (
    await createDisciplineIncident(database!.sql, schoolId, {
      studentId: ids.omar,
      reporterUserId: ids.teacherUser,
      title: "Quokka playground scuffle",
    })
  ).id;
  // Inserted with app.user_id set to the evaluator: teacher_evaluation_visibility (a restrictive
  // SELECT policy TO PUBLIC) also gates INSERT ... RETURNING.
  ids.evaluation = await seed(schoolId, async (tx) => {
    await tx`SELECT set_config('app.user_id', ${people.principal}, true)`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.teacher_evaluations (school_id, teacher_id, evaluator_user_id, evaluation_type, evaluated_at)
      VALUES (${schoolId}, ${teacher.id}, ${people.principal}, 'formal_observation', now())
      RETURNING id
    `;
    return row!.id;
  });
}

async function seedSchoolB(): Promise<void> {
  const schoolId = b.schoolId;
  await createStudent(database!.sql, schoolId, { firstName: "Isolde", lastName: "Tenantcanary" });
  await createStudent(database!.sql, schoolId, { firstName: "Omar", lastName: "Elsewhere" });
  await seed(schoolId, async (tx) => {
    await tx`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
      VALUES (${schoolId}, 'TC-1', 'Tenantcanary Hall', 'physical', 10, 'B Block')
    `;
    await tx`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}, 'Tenantcanary Family', ${b.users.PARENT.id})
    `;
    await tx`
      INSERT INTO app.scholarships (school_id, name, discount_type, percentage, is_active, created_by)
      VALUES (${schoolId}, 'Tenantcanary Grant', 'percentage', 5, true, ${b.users.ORG_ADMIN.id})
    `;
    await tx`
      INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
      VALUES (${schoolId}, ${b.users.ORG_ADMIN.id}, 'ADMIN_ANNOUNCEMENT', 'Tenantcanary note', 'b', '{}'::jsonb)
    `;
  });
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  harness = createTestApp({ database: database.sql });
  await harness.ready;
  a = await createFullTenant(database.sql);
  b = await createFullTenant(database.sql);
  await seedSchoolA();
  await seedSchoolB();
}, 120_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

describeDb("GET /api/search — contract", () => {
  test("every type key is present in results and totals; types echoes the request", async () => {
    const { status, body } = await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], "quokka");
    expect(status).toBe(200);
    expect(Object.keys(body.results).sort()).toEqual([...SEARCH_TYPES].sort());
    expect(Object.keys(body.totals).sort()).toEqual([...SEARCH_TYPES].sort());
    expect(body.types).toEqual([...SEARCH_TYPES]);
  });

  test("hits never carry bodies, descriptions, storage keys or payloads", async () => {
    const { body } = await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], "quokka");
    const text = JSON.stringify(body);
    expect(text).not.toContain("Secretive description");
    expect(text).not.toContain("private note");
    expect(text).not.toContain("permanent/secret");
    expect(text).not.toContain("Body text");
  });

  test("rejects an unknown type and an out-of-range offset", async () => {
    const admin = a.users.ORG_ADMIN.id;
    expect((await search(a, admin, [ROLES.ORG_ADMIN], "quokka", "&types=nope")).status).toBe(400);
    expect((await search(a, admin, [ROLES.ORG_ADMIN], "quokka", "&offset=-1")).status).toBe(400);
    expect((await search(a, admin, [ROLES.ORG_ADMIN], "quokka", "&offset=1001")).status).toBe(400);
  });
});

describeDb("GET /api/search — sections by role", () => {
  test("ORG_ADMIN finds every school-wide section", async () => {
    const { body } = await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], "quokka");
    expect(idsOf(body, "announcements")).toEqual([ids.announcement]);
    expect(idsOf(body, "events")).toEqual([ids.event]);
    expect(idsOf(body, "incidents")).toEqual([ids.incident]);
    expect(idsOf(body, "fee_structures")).toEqual([ids.feeStructure]);
    expect(idsOf(body, "scholarships")).toEqual([ids.scholarship]);
    expect(idsOf(body, "expenses")).toEqual([ids.expense]);
    // Only the caller's own inbox, never the principal's.
    expect(idsOf(body, "notifications")).toEqual([ids.adminNotification]);
    expect(body.results.incidents[0]!.student_id).toBe(ids.omar);
    expect(body.results.incidents[0]!.student_name).toBe("Omar Haddad");
    expect(body.results.fee_structures[0]!.academic_year_id).toBe(a.academicYear.id);

    const academics = await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], "nebula");
    expect(idsOf(academics.body, "grade_levels")).toEqual([ids.gradeLevel]);
    expect(
      idsOf(
        (await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], "Grade Nebula Corvid")).body,
        "sections",
      ),
    ).toEqual([ids.section]);
    expect(
      idsOf((await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], "orion")).body, "rooms"),
    ).toEqual([ids.room]);
    expect(
      idsOf(
        (await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], "astronomy")).body,
        "subjects",
      ),
    ).toEqual([ids.subject]);
    // A class is found by its own code and by its course's name.
    expect(
      idsOf((await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], "zephyr")).body, "classes"),
    ).toEqual([ids.zephyrClass]);
    expect(
      idsOf(
        (await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], "stargazing")).body,
        "classes",
      ),
    ).toEqual([ids.zephyrClass]);
    const year = await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], a.academicYear.code);
    expect(idsOf(year.body, "academic_years")).toEqual([a.academicYear.id]);
    const term = await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], a.term.code);
    expect(idsOf(term.body, "terms")).toEqual([a.term.id]);
    expect(term.body.results.terms[0]!.academic_year_id).toBe(a.academicYear.id);
    const families = await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], "family");
    expect(idsOf(families.body, "families").sort()).toEqual(
      [ids.ownFamily, ids.otherFamily].sort(),
    );
  });

  test("ORG_ADMIN does not see an evaluation it did not author (teacher_evaluation_visibility)", async () => {
    const { body } = await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], "marlowe");
    expect(body.results.evaluations).toEqual([]);
    expect(body.totals.evaluations).toBe(0);
  });

  test("PRINCIPAL finds incidents, announcements, its own evaluations; no finance sections", async () => {
    const principal = people.principal;
    const { body } = await search(a, principal, [ROLES.PRINCIPAL], "quokka");
    expect(idsOf(body, "incidents")).toEqual([ids.incident]);
    expect(idsOf(body, "announcements")).toEqual([ids.announcement]);
    expect(idsOf(body, "events")).toEqual([ids.event]);
    expect(idsOf(body, "notifications")).toEqual([ids.principalNotification]);
    for (const type of ["fee_structures", "scholarships", "expenses", "invoices"] as const) {
      expect(body.results[type]).toEqual([]);
      expect(body.totals[type]).toBe(0);
    }
    const evaluations = await search(a, principal, [ROLES.PRINCIPAL], "marlowe");
    expect(idsOf(evaluations.body, "evaluations")).toEqual([ids.evaluation]);
    expect(evaluations.body.results.evaluations[0]!.teacher_user_id).toBe(ids.teacherUser);
    expect((await search(a, principal, [ROLES.PRINCIPAL], "family")).body.results.families).toEqual(
      [],
    );
  });

  test("SUPPORT_AGENT holds disciplineIncident:read but not the principal gate: no incidents", async () => {
    const { body } = await search(a, a.users.SUPPORT_AGENT.id, [ROLES.SUPPORT_AGENT], "quokka");
    expect(body.results.incidents).toEqual([]);
    expect(body.totals.incidents).toBe(0);
  });

  test("FINANCE finds finance sections and families (own columns only), never academics or incidents", async () => {
    const finance = people.finance;
    const { body } = await search(a, finance, [ROLES.FINANCE], "quokka");
    expect(idsOf(body, "fee_structures")).toEqual([ids.feeStructure]);
    expect(idsOf(body, "scholarships")).toEqual([ids.scholarship]);
    expect(idsOf(body, "expenses")).toEqual([ids.expense]);
    for (const type of ["incidents", "announcements", "events", "evaluations"] as const) {
      expect(body.results[type]).toEqual([]);
    }
    const families = await search(a, finance, [ROLES.FINANCE], "family");
    expect(idsOf(families.body, "families").sort()).toEqual(
      [ids.ownFamily, ids.otherFamily].sort(),
    );
    // FINANCE reads no class under role_scope_visibility, even though the section is open.
    expect((await search(a, finance, [ROLES.FINANCE], "zephyr")).body.results.classes).toEqual([]);
    const invoice = await search(a, finance, [ROLES.FINANCE], "inv-00");
    expect(idsOf(invoice.body, "invoices")).toEqual([ids.invoice]);
    expect(invoice.body.results.invoices[0]!.student_name).toBeNull();
  });

  test("INSTRUCTOR: own classes and students only; open academic sections; no leadership or finance", async () => {
    const teacher = ids.teacherUser;
    const roles = [ROLES.INSTRUCTOR];
    const zephyr = await search(a, teacher, roles, "zephyr");
    expect(zephyr.body.results.classes).toEqual([]);
    expect(zephyr.body.totals.classes).toBe(0);
    const own = await search(a, teacher, roles, a.cls.code);
    expect(idsOf(own.body, "classes")).toEqual([ids.teacherClass]);
    // Omar is enrolled only in a class this teacher does not teach.
    expect((await search(a, teacher, roles, "omar")).body.results.students).toEqual([]);
    expect(idsOf((await search(a, teacher, roles, "TestStudent")).body, "students")).toEqual([
      a.students[0]!.id,
    ]);
    // Sections, rooms and grade levels are open to every school member, like their list endpoints.
    expect(idsOf((await search(a, teacher, roles, "orion")).body, "rooms")).toEqual([ids.room]);
    expect(idsOf((await search(a, teacher, roles, "nebula")).body, "grade_levels")).toEqual([
      ids.gradeLevel,
    ]);
    const quokka = await search(a, teacher, roles, "quokka");
    expect(idsOf(quokka.body, "events")).toEqual([ids.event]);
    for (const type of [
      "announcements",
      "incidents",
      "fee_structures",
      "scholarships",
      "expenses",
      "notifications",
      "families",
      "invoices",
    ] as const) {
      expect(quokka.body.results[type]).toEqual([]);
    }
    // No evaluation:read -> no evaluations section at all.
    expect((await search(a, teacher, roles, "marlowe")).body.results.evaluations).toEqual([]);
  });

  test("PARENT: own family and own child only", async () => {
    const parent = a.users.PARENT.id;
    const families = await search(a, parent, [ROLES.PARENT], "family");
    expect(idsOf(families.body, "families")).toEqual([ids.ownFamily]);
    expect(families.body.totals.families).toBe(1);
    expect(
      idsOf((await search(a, parent, [ROLES.PARENT], "TestStudent")).body, "students"),
    ).toEqual([a.students[0]!.id]);
    expect((await search(a, parent, [ROLES.PARENT], "omar")).body.results.students).toEqual([]);
    const quokka = await search(a, parent, [ROLES.PARENT], "quokka");
    for (const type of ["incidents", "events", "announcements", "scholarships"] as const) {
      expect(quokka.body.results[type]).toEqual([]);
    }
  });

  test("ATTENDANCE_OFFICER reads every student and class (school-wide attendance scope)", async () => {
    const { body } = await search(a, people.attendance, [ROLES.ATTENDANCE_OFFICER], "zephyr");
    expect(idsOf(body, "classes")).toEqual([ids.zephyrClass]);
    const omar = await search(a, people.attendance, [ROLES.ATTENDANCE_OFFICER], "omar");
    expect(idsOf(omar.body, "students")).toEqual([ids.omar]);
  });
});

describeDb("GET /api/search — tenant isolation", () => {
  test("school B's rows never reach school A, and B finds its own", async () => {
    const inA = await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], "tenantcanary");
    expect(Object.values(inA.body.totals).every((total) => total === 0)).toBe(true);
    const omarInA = await search(a, a.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], "omar");
    expect(idsOf(omarInA.body, "students")).toEqual([ids.omar]);

    const inB = await search(b, b.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN], "tenantcanary");
    expect(inB.body.totals.students).toBe(1);
    expect(inB.body.totals.rooms).toBe(1);
    expect(inB.body.totals.families).toBe(1);
    expect(inB.body.totals.scholarships).toBe(1);
    expect(inB.body.totals.notifications).toBe(1);
  });
});

describeDb("GET /api/search — matching", () => {
  const admin = () => a.users.ORG_ADMIN.id;

  test("the last word is a prefix; earlier words must match whole", async () => {
    expect(idsOf((await search(a, admin(), [ROLES.ORG_ADMIN], "oma")).body, "students")).toEqual([
      ids.omar,
    ]);
    expect(
      idsOf((await search(a, admin(), [ROLES.ORG_ADMIN], "omar hadd")).body, "students"),
    ).toEqual([ids.omar]);
    // Invoices have no typo fallback, so the whole-word rule for earlier words shows directly:
    // "in" is not a prefix match, only the last word is.
    expect((await search(a, admin(), [ROLES.ORG_ADMIN], "in 0012")).body.results.invoices).toEqual(
      [],
    );
    expect(
      idsOf((await search(a, admin(), [ROLES.ORG_ADMIN], "inv 001")).body, "invoices"),
    ).toEqual([ids.invoice]);
    // Students do have one: "oma haddad" matches nothing exactly, then Omar by similarity.
    const fuzzy = await search(a, admin(), [ROLES.ORG_ADMIN], "oma haddad");
    expect(idsOf(fuzzy.body, "students")).toEqual([ids.omar]);
    expect(fuzzy.body.results.students[0]!.rank).toBeLessThan(1);
  });

  test("hyphenated document numbers match on their parts", async () => {
    expect(idsOf((await search(a, admin(), [ROLES.ORG_ADMIN], "inv-00")).body, "invoices")).toEqual(
      [ids.invoice],
    );
    expect(
      idsOf((await search(a, admin(), [ROLES.ORG_ADMIN], "INV-0012")).body, "invoices"),
    ).toEqual([ids.invoice]);
    expect(
      idsOf((await search(a, admin(), [ROLES.ORG_ADMIN], "pinv 004")).body, "expenses"),
    ).toEqual([ids.expense]);
  });

  test("Arabic: alef forms, taa marbuta and diacritics are normalized on both sides", async () => {
    // Seeded احمد, searched أحمد (and with harakat).
    expect(idsOf((await search(a, admin(), [ROLES.ORG_ADMIN], "أحمد")).body, "students")).toEqual([
      ids.ahmad,
    ]);
    expect(
      idsOf((await search(a, admin(), [ROLES.ORG_ADMIN], "أَحْمَد")).body, "students"),
    ).toEqual([ids.ahmad]);
    // Seeded أمينة, searched امينه.
    expect(idsOf((await search(a, admin(), [ROLES.ORG_ADMIN], "امينه")).body, "students")).toEqual([
      ids.amina,
    ]);
    expect(idsOf((await search(a, admin(), [ROLES.ORG_ADMIN], "اميـنة")).body, "students")).toEqual(
      [ids.amina],
    );
  });

  test("a typo falls back to trigram similarity, and only when full-text found nothing", async () => {
    const typo = await search(a, admin(), [ROLES.ORG_ADMIN], "Bartholemew");
    expect(idsOf(typo.body, "students")).toEqual([ids.bartholomew]);
    expect(typo.body.totals.students).toBe(1);
    expect(typo.body.results.students[0]!.rank).toBeGreaterThanOrEqual(0.5);
    const familyTypo = await search(a, admin(), [ROLES.ORG_ADMIN], "halvorsn");
    expect(idsOf(familyTypo.body, "families")).toEqual([ids.ownFamily]);
    // Nothing similar enough: still empty.
    expect((await search(a, admin(), [ROLES.ORG_ADMIN], "qqzzxx")).body.totals.students).toBe(0);
  });

  test("RLS-scoped sections fall back to trigram only when the school has no full-text candidate", async () => {
    const teacher = ids.teacherUser;
    const roles = [ROLES.INSTRUCTOR];
    // "brightwatter" is trigram-similar enough to the teacher's own Brightwater that the fallback,
    // had it run, would return him.
    const [similarity] = await database!.sql<{ value: number }[]>`
      SELECT word_similarity(app.search_normalize('brightwatter'), s.search_name) AS value
      FROM app.students s WHERE s.id = ${ids.brightwater}
    `;
    expect(similarity!.value).toBeGreaterThanOrEqual(SEARCH_TRIGRAM_FLOOR);

    // An exact name that exists only outside the teacher's classes: full-text has a candidate in
    // the school, RLS hides it, and the fallback does not run -- so Brightwater is not returned.
    const outside = await search(a, teacher, roles, "brightwatter");
    expect(outside.body.results.students).toEqual([]);
    expect(outside.body.totals.students).toBe(0);

    // A typo of the teacher's own student: no full-text candidate anywhere, so the fallback runs,
    // and RLS still hides the similar student outside the teacher's classes.
    const ownTypo = await search(a, teacher, roles, "brightwatr");
    expect(idsOf(ownTypo.body, "students")).toEqual([ids.brightwater]);
    expect(ownTypo.body.totals.students).toBe(1);
    expect(ownTypo.body.results.students[0]!.rank).toBeGreaterThanOrEqual(SEARCH_TRIGRAM_FLOOR);

    // An admin sees every candidate: the exact name by full-text, the typo by the fallback.
    const exact = await search(a, admin(), [ROLES.ORG_ADMIN], "brightwatter");
    expect(idsOf(exact.body, "students")).toEqual([ids.brightwatter]);
    const adminTypo = await search(a, admin(), [ROLES.ORG_ADMIN], "brightwatr");
    expect(idsOf(adminTypo.body, "students").sort()).toEqual(
      [ids.brightwater, ids.brightwatter].sort(),
    );
    expect(adminTypo.body.totals.students).toBe(2);
  });

  test("a school-defined record answer is never found", async () => {
    const { body } = await search(a, admin(), [ROLES.ORG_ADMIN], "xylophonia");
    expect(Object.values(body.totals).every((total) => total === 0)).toBe(true);
    expect(Object.values(body.results).every((hits) => hits.length === 0)).toBe(true);
    const peanut = await search(a, admin(), [ROLES.ORG_ADMIN], "peanut");
    expect(JSON.stringify(peanut.body)).not.toContain(ids.recordStudent);
  });

  test("a query with no letters or digits matches nothing and is not an error", async () => {
    const { status, body } = await search(a, admin(), [ROLES.ORG_ADMIN], "&|!:*");
    expect(status).toBe(200);
    expect(Object.values(body.totals).every((total) => total === 0)).toBe(true);
  });
});

describeDb("GET /api/search — types, offset, totals", () => {
  const admin = () => a.users.ORG_ADMIN.id;

  test("types narrows the sections that run; the rest stay empty with zero totals", async () => {
    const { body } = await search(
      a,
      admin(),
      [ROLES.ORG_ADMIN],
      "quokka",
      "&types=events&types=rooms",
    );
    expect(body.types).toEqual(["rooms", "events"]);
    expect(idsOf(body, "events")).toEqual([ids.event]);
    expect(body.results.announcements).toEqual([]);
    expect(body.totals.announcements).toBe(0);
    const comma = await search(
      a,
      admin(),
      [ROLES.ORG_ADMIN],
      "quokka",
      "&types=events,announcements",
    );
    expect(comma.body.types).toEqual(["announcements", "events"]);
    expect(idsOf(comma.body, "announcements")).toEqual([ids.announcement]);
  });

  test("offset pages one type; totals stay the full count, even past the end", async () => {
    const page = async (offset: number) =>
      (
        await search(
          a,
          admin(),
          [ROLES.ORG_ADMIN],
          "pagetest",
          `&types=students&limit=3&offset=${offset}`,
        )
      ).body;
    const first = await page(0);
    const second = await page(3);
    const third = await page(6);
    const beyond = await page(9);
    expect(first.totals.students).toBe(7);
    expect(second.totals.students).toBe(7);
    expect(third.totals.students).toBe(7);
    expect(beyond.totals.students).toBe(7);
    expect(first.results.students).toHaveLength(3);
    expect(third.results.students).toHaveLength(1);
    expect(beyond.results.students).toEqual([]);
    const seen = [
      ...first.results.students,
      ...second.results.students,
      ...third.results.students,
    ].map((hit) => hit.id);
    expect(new Set(seen).size).toBe(7);
    expect(seen.sort()).toEqual([...pagetestIds].sort());
    expect(first.totals.users).toBe(0);
  });

  test("the audit row records query, types, offset, sections run and counts -- never hit values", async () => {
    await search(a, admin(), [ROLES.ORG_ADMIN], "pagetest", "&types=students&offset=3&limit=2");
    const rows = await database!.sql<{ new_values: Record<string, unknown> }[]>`
      SELECT new_values FROM app.audit_logs
      WHERE school_id = ${a.schoolId} AND target_table = 'global_search' AND actor_id = ${admin()}
        AND new_values->>'query' = 'pagetest' AND (new_values->>'offset')::int = 3
        AND (new_values->>'limit')::int = 2
    `;
    expect(rows).toHaveLength(1);
    const values = rows[0]!.new_values;
    expect(values.types).toEqual(["students"]);
    expect(values.sections).toEqual(["students"]);
    expect(values.result_counts).toEqual({ students: 2 });
    expect(values.totals).toEqual({ students: 7 });
    expect(JSON.stringify(values)).not.toContain(pagetestIds[0]!);
  });
});
