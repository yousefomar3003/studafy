/**
 * Migration 000176 rewrote role_scope_visibility on app.classes, timetable_slots, materials,
 * assignments and exams to test `class_id IN (SELECT app.readable_class_ids())` -- one set computed
 * per statement -- instead of calling app.can_read_class per row. Its header claims the visible rows
 * are unchanged for every caller. This proves it on live data: for each caller and table, the ids
 * visible as studafy_app under the live policy must equal the ids the REPLACED predicate selects for
 * that same caller.
 *
 * The replaced set is computed as the test database's connecting role -- a superuser, so no policy
 * applies -- with the caller's GUCs set and the replaced policy written out as the WHERE clause
 * (000171's hoisted forms reduce to these, which its own equivalence test proves):
 *   classes          app.can_read_class_for_attendance(id)        (000133)
 *   timetable_slots  app.can_read_class_for_attendance(class_id)  (000133)
 *   materials        app.can_read_class(class_id)                 (000037)
 *   assignments      app.can_read_class(class_id)                 (000037)
 *   exams            app.can_read_class(class_id)                 (000037)
 * together with tenant_isolation's `school_id = current_setting('app.school_id')::uuid`.
 *
 * Seed, per school: the fixture class led by the fixture teacher; a second class led by another
 * teacher; and a third, also led by the other teacher, in which the fixture teacher holds a timetable
 * slot -- the substitute path through teaches_class that only a slot grants. Each class carries a
 * slot, a material, an assignment and an exam. The parent is linked to the fixture student, who is
 * enrolled in the fixture class only. School B mirrors A, so no scope may reach across schools.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/security/set-based-class-visibility.integration.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  createClass,
  createCourse,
  createEnrollment,
  createFullTenant,
  createMaterial,
  createStudent,
  createSubject,
  createTeacher,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TenantFixture, TestDatabase } from "../harness";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

/** The policy each table had before 000176, as a WHERE clause (see the header). */
const REPLACED_PREDICATES = {
  classes: "app.can_read_class_for_attendance(id)",
  timetable_slots: "app.can_read_class_for_attendance(class_id)",
  materials: "app.can_read_class(class_id)",
  assignments: "app.can_read_class(class_id)",
  exams: "app.can_read_class(class_id)",
} as const;
type Table = keyof typeof REPLACED_PREDICATES;
const TABLES = Object.keys(REPLACED_PREDICATES) as Table[];
/** The tables whose rows hang off a class through class_id (everything but classes itself). */
const CLASS_OWNED = ["timetable_slots", "materials", "assignments", "exams"] as const;

const JULY = "2026-07-01T08:00:00Z";
const JULY_END = "2026-07-01T10:00:00Z";

interface Caller {
  label: string;
  schoolId: string;
  userId: string;
}

let database: TestDatabase | undefined;
let a: TenantFixture;
let b: TenantFixture;
const callers: Caller[] = [];
/** Every row id per table and school, read as the superuser without any predicate. */
const allIds = { a: {}, b: {} } as Record<"a" | "b", Record<Table, string[]>>;
/** School A's three classes, for the sanity checks. */
const own = {} as { teacherClass: string; otherClass: string; substituteClass: string };

async function withCaller<T>(
  caller: Caller,
  asApp: boolean,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await database!.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${caller.schoolId}, true)`;
    await tx`SELECT set_config('app.user_id', ${caller.userId}, true)`;
    if (asApp) await tx.unsafe("SET LOCAL ROLE studafy_app");
    result = await fn(tx);
  });
  return result as T;
}

async function idsOf(tx: TransactionSql, query: string): Promise<string[]> {
  const rows = (await tx.unsafe(query)) as unknown as { id: string }[];
  return rows.map((row) => row.id).sort();
}

/** The live policy (000176): what studafy_app sees with the caller's GUCs. */
function visibleNow(caller: Caller, table: Table): Promise<string[]> {
  return withCaller(caller, true, (tx) => idsOf(tx, `SELECT id FROM app.${table}`));
}

/** Class ids of the class-owned rows the caller sees under the live policy. */
function visibleClassesOf(caller: Caller, table: (typeof CLASS_OWNED)[number]): Promise<string[]> {
  return withCaller(caller, true, async (tx) => {
    const rows = (await tx.unsafe(
      `SELECT DISTINCT class_id AS id FROM app.${table}`,
    )) as unknown as {
      id: string;
    }[];
    return rows.map((row) => row.id).sort();
  });
}

/** The replaced predicate, evaluated without RLS for the same caller. */
function visibleBefore(caller: Caller, table: Table): Promise<string[]> {
  return withCaller(caller, false, async (tx) => {
    const [role] = await tx<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    // A non-superuser would have policies applied here and the comparison would prove nothing.
    expect(role!.rolsuper || role!.rolbypassrls).toBe(true);
    return idsOf(
      tx,
      `SELECT id FROM app.${table}
        WHERE school_id = current_setting('app.school_id')::uuid
          AND (${REPLACED_PREDICATES[table]})`,
    );
  });
}

async function readAll(schoolId: string): Promise<Record<Table, string[]>> {
  const out = {} as Record<Table, string[]>;
  for (const table of TABLES) {
    out[table] = (
      await database!.sql<{ id: string }[]>`
        SELECT id FROM app.${database!.sql(table)} WHERE school_id = ${schoolId}
      `
    )
      .map((row) => row.id)
      .sort();
  }
  return out;
}

async function seedSchool(tenant: TenantFixture, suffix: string): Promise<void> {
  const sql = database!.sql;
  const schoolId = tenant.schoolId;
  const teacher = tenant.teachers[0]!;

  const otherTeacher = await createTeacher(sql, schoolId);
  const otherSubject = await createSubject(sql, schoolId, { code: `OTH-${suffix}` });
  const otherCourse = await createCourse(sql, schoolId, otherSubject.id, { code: `OCR-${suffix}` });
  const classFor = (code: string) =>
    createClass(sql, schoolId, {
      courseId: otherCourse.id,
      academicYearId: tenant.academicYear.id,
      termId: tenant.term.id,
      leadTeacherId: otherTeacher.id,
      roomId: tenant.room.id,
      code,
    });
  const otherClass = await classFor(`OCL-${suffix}`);
  const substituteClass = await classFor(`SUB-${suffix}`);

  const classmate = await createStudent(sql, schoolId, { firstName: "Other", lastName: suffix });
  await createEnrollment(sql, schoolId, otherClass.id, classmate.id);
  const substituteStudent = await createStudent(sql, schoolId, {
    firstName: "Sub",
    lastName: suffix,
  });
  await createEnrollment(sql, schoolId, substituteClass.id, substituteStudent.id);

  const uploader = tenant.users.ORG_ADMIN.id;
  const classes = [
    { id: tenant.cls.id, slotTeacher: teacher.id },
    { id: otherClass.id, slotTeacher: otherTeacher.id },
    // Led by the other teacher, but the fixture teacher holds its slot.
    { id: substituteClass.id, slotTeacher: teacher.id },
  ];
  for (const cls of classes) {
    await createMaterial(sql, schoolId, { classId: cls.id, uploadedByUserId: uploader });
  }

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    // role_scope_visibility also gates INSERT ... RETURNING; seed as studafy_admin (see createStudent).
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [version] = await tx<{ id: string }[]>`
      INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name)
      VALUES (${schoolId}, ${tenant.academicYear.id}, ${tenant.term.id}, ${`000176 ${suffix}`})
      RETURNING id
    `;
    for (const [index, cls] of classes.entries()) {
      // A distinct period per slot, so neither teacher nor room is double-booked.
      await tx`
        INSERT INTO app.timetable_slots
          (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
        VALUES (${schoolId}, ${version!.id}, ${cls.id}, ${cls.slotTeacher}, ${tenant.room.id}, 1,
          ${index + 1})
      `;
      await tx`
        INSERT INTO app.assignments
          (school_id, class_id, created_by_user_id, last_edited_by_user_id, title, status,
           assigned_at, due_at, max_score)
        VALUES (${schoolId}, ${cls.id}, ${uploader}, ${uploader}, ${`Essay ${String(index)}`},
          'published', ${JULY}::timestamptz, ${JULY}::timestamptz, 100)
      `;
      await tx`
        INSERT INTO app.exams
          (school_id, class_id, created_by_user_id, last_edited_by_user_id, title, status,
           starts_at, ends_at, max_score)
        VALUES (${schoolId}, ${cls.id}, ${uploader}, ${uploader}, ${`Midterm ${String(index)}`},
          'closed', ${JULY}::timestamptz, ${JULY_END}::timestamptz, 100)
      `;
    }

    // The PARENT fixture user is the parent of the fixture student only.
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}, ${`Family ${suffix}`}, ${tenant.users.PARENT.id}) RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links (school_id, parent_user_id, student_id, relationship, family_id)
      VALUES (${schoolId}, ${tenant.users.PARENT.id}, ${tenant.students[0]!.id}, 'guardian', ${family!.id})
    `;
  });

  await assignRole(sql, schoolId, teacher.userId, ROLES.INSTRUCTOR);
  await assignRole(sql, schoolId, otherTeacher.userId, ROLES.INSTRUCTOR);

  if (suffix === "A") {
    own.teacherClass = tenant.cls.id;
    own.otherClass = otherClass.id;
    own.substituteClass = substituteClass.id;
  }
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  a = await createFullTenant(database.sql);
  b = await createFullTenant(database.sql);
  await seedSchool(a, "A");
  await seedSchool(b, "B");

  const officer = await createUser(database.sql, a.schoolId, { displayName: "Officer" });
  await assignRole(database.sql, a.schoolId, officer.id, ROLES.ATTENDANCE_OFFICER);
  const finance = await createUser(database.sql, a.schoolId, { displayName: "Finance" });
  await assignRole(database.sql, a.schoolId, finance.id, ROLES.FINANCE);

  callers.push(
    { label: "A admin (ORG_ADMIN)", schoolId: a.schoolId, userId: a.users.ORG_ADMIN.id },
    { label: "A teacher (lead + substitute)", schoolId: a.schoolId, userId: a.teachers[0]!.userId },
    { label: "A parent of one child", schoolId: a.schoolId, userId: a.users.PARENT.id },
    { label: "A attendance officer", schoolId: a.schoolId, userId: officer.id },
    { label: "A FINANCE", schoolId: a.schoolId, userId: finance.id },
    { label: "A student", schoolId: a.schoolId, userId: a.students[0]!.userId },
    { label: "B admin (ORG_ADMIN)", schoolId: b.schoolId, userId: b.users.ORG_ADMIN.id },
  );

  allIds.a = await readAll(a.schoolId);
  allIds.b = await readAll(b.schoolId);
}, 180_000);

afterAll(async () => {
  await database?.cleanup();
});

describeDb("000176 set-based class visibility: same visible rows as 000133 / 000037", () => {
  test("the live policies are the set-based ones this test is meant to check", async () => {
    const rows = await database!.sql<{ table: string; qual: string }[]>`
      SELECT tablename AS table, qual FROM pg_policies
      WHERE schemaname = 'app' AND policyname = 'role_scope_visibility'
        AND tablename = ANY(${TABLES as unknown as string[]})
      ORDER BY tablename
    `;
    expect(rows.map((row) => row.table)).toEqual([...TABLES].sort());
    for (const row of rows) {
      expect(row.qual).toContain("app.readable_class_ids()");
      expect(row.qual).not.toContain("can_read_class");
    }
  });

  test("every caller sees exactly the rows the replaced predicate selects, on every table", async () => {
    const matrix: Record<string, Record<Table, string>> = {};
    for (const caller of callers) {
      matrix[caller.label] = {} as Record<Table, string>;
      for (const table of TABLES) {
        const now = await visibleNow(caller, table);
        const before = await visibleBefore(caller, table);
        expect({ caller: caller.label, table, ids: now }).toEqual({
          caller: caller.label,
          table,
          ids: before,
        });
        const total = (caller.schoolId === a.schoolId ? allIds.a : allIds.b)[table].length;
        matrix[caller.label]![table] = `${String(now.length)}/${String(total)}`;
      }
    }
    // Visible / school total per cell, for the record when this runs verbosely.
    console.info("[class-visibility-equivalence] visible/total", JSON.stringify(matrix));
  });

  test("the comparison is not vacuous: scopes differ by caller and never cross schools", async () => {
    const [admin, teacher, parent, officer, finance, student, adminB] = callers as [
      Caller,
      Caller,
      Caller,
      Caller,
      Caller,
      Caller,
      Caller,
    ];
    for (const table of TABLES) {
      expect(await visibleNow(admin, table)).toEqual(allIds.a[table]);
      expect(await visibleNow(adminB, table)).toEqual(allIds.b[table]);
      expect(await visibleNow(finance, table)).toEqual([]);
      for (const caller of callers) {
        const other = caller.schoolId === a.schoolId ? allIds.b : allIds.a;
        const seen = await visibleNow(caller, table);
        expect(seen.filter((id) => other[table].includes(id))).toEqual([]);
      }
    }

    // Officers read every class and slot, and nothing else a class carries.
    expect(await visibleNow(officer, "classes")).toEqual(allIds.a.classes);
    expect(await visibleNow(officer, "timetable_slots")).toEqual(allIds.a.timetable_slots);
    for (const table of ["materials", "assignments", "exams"] as const) {
      expect(await visibleNow(officer, table)).toEqual([]);
    }

    // The teacher reaches its led class and, through a slot alone, the substitute class.
    const teaching = [own.teacherClass, own.substituteClass].sort();
    expect((await visibleNow(teacher, "classes")).sort()).toEqual(teaching);
    for (const table of CLASS_OWNED) {
      expect(await visibleClassesOf(teacher, table)).toEqual(teaching);
    }

    // Student and parent see only the fixture class the student is enrolled in.
    for (const caller of [student, parent]) {
      expect(await visibleNow(caller, "classes")).toEqual([own.teacherClass]);
      for (const table of CLASS_OWNED) {
        expect(await visibleClassesOf(caller, table)).toEqual([own.teacherClass]);
      }
    }
  });
});
