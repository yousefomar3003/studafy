/**
 * Migration 000171 rewrote role_scope_visibility on app.students, classes, courses, subjects and
 * materials, hoisting `(SELECT app.current_user_is_school_admin())` (and, except on materials,
 * `(SELECT app.current_user_is_attendance_officer())`) in front of the predicate 000133 / 000037
 * left there. Its header claims the visible rows are unchanged for every caller. This proves it on
 * live data: for each caller and table, the ids visible as studafy_app under the live policy must
 * equal the ids the ORIGINAL predicate selects for that same caller.
 *
 * The original set is computed as the test database's connecting role -- a superuser, so no policy
 * applies -- with the caller's GUCs set and the original policy written out as the WHERE clause:
 *   students   app.can_read_student_for_attendance(id)                                (000133)
 *   classes    app.can_read_class_for_attendance(id)                                  (000133)
 *   courses    app.can_read_course(id) OR app.current_user_is_attendance_officer()    (000133)
 *   subjects   app.can_read_subject(id) OR app.current_user_is_attendance_officer()   (000133)
 *   materials  app.can_read_class(class_id)                                           (000037)
 * together with tenant_isolation's `school_id = current_setting('app.school_id')::uuid`.
 *
 * Seed: school A with an admin, a teacher of one class (a second class has another teacher), a
 * parent of one child, an attendance officer, a FINANCE user and a student; school B with its own
 * admin and rows. Each caller's set is also checked not to be trivially empty or trivially "all"
 * where the role makes that meaningful, and never to reach the other school.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/search/global-search-policy-equivalence.integration.test.ts
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

/** The policy each table had before 000171, as a WHERE clause (see the header). */
const ORIGINAL_PREDICATES = {
  students: "app.can_read_student_for_attendance(id)",
  classes: "app.can_read_class_for_attendance(id)",
  courses: "app.can_read_course(id) OR app.current_user_is_attendance_officer()",
  subjects: "app.can_read_subject(id) OR app.current_user_is_attendance_officer()",
  materials: "app.can_read_class(class_id)",
} as const;
type Table = keyof typeof ORIGINAL_PREDICATES;
const TABLES = Object.keys(ORIGINAL_PREDICATES) as Table[];

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
/** Rows that belong to the teacher's own class / the parent's child, for the sanity checks. */
const own = {} as { teacherClass: string; otherClass: string; child: string };

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

/** The live policy (000171): what studafy_app sees with the caller's GUCs. */
function visibleNow(caller: Caller, table: Table): Promise<string[]> {
  return withCaller(caller, true, (tx) => idsOf(tx, `SELECT id FROM app.${table}`));
}

/** The original predicate, evaluated without RLS for the same caller. */
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
          AND (${ORIGINAL_PREDICATES[table]})`,
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

  // A second subject / course / class taught by someone else, so a teacher's scope is a strict
  // subset; a second student in it and a third in no class at all.
  const otherTeacher = await createTeacher(sql, schoolId);
  const otherSubject = await createSubject(sql, schoolId, { code: `OTH-${suffix}` });
  const otherCourse = await createCourse(sql, schoolId, otherSubject.id, { code: `OCR-${suffix}` });
  const otherClass = await createClass(sql, schoolId, {
    courseId: otherCourse.id,
    academicYearId: tenant.academicYear.id,
    termId: tenant.term.id,
    leadTeacherId: otherTeacher.id,
    roomId: tenant.room.id,
    code: `OCL-${suffix}`,
  });
  const classmate = await createStudent(sql, schoolId, { firstName: "Other", lastName: suffix });
  await createEnrollment(sql, schoolId, otherClass.id, classmate.id);
  await createStudent(sql, schoolId, { firstName: "Unenrolled", lastName: suffix });

  const uploader = tenant.users.ORG_ADMIN.id;
  await createMaterial(sql, schoolId, { classId: tenant.cls.id, uploadedByUserId: uploader });
  await createMaterial(sql, schoolId, { classId: otherClass.id, uploadedByUserId: uploader });

  // The PARENT fixture user is the parent of the primary student only.
  await database!.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}, ${`Family ${suffix}`}, ${tenant.users.PARENT.id}) RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links (school_id, parent_user_id, student_id, relationship, family_id)
      VALUES (${schoolId}, ${tenant.users.PARENT.id}, ${tenant.students[0]!.id}, 'guardian', ${family!.id})
    `;
  });

  // The fixture teacher teaches tenant.cls; give both teachers their role as the app would.
  await assignRole(sql, schoolId, tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);
  await assignRole(sql, schoolId, otherTeacher.userId, ROLES.INSTRUCTOR);

  if (suffix === "A") {
    own.teacherClass = tenant.cls.id;
    own.otherClass = otherClass.id;
    own.child = tenant.students[0]!.id;
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
    { label: "A teacher of one class", schoolId: a.schoolId, userId: a.teachers[0]!.userId },
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

describeDb("000171 role_scope_visibility rewrite: same visible rows as 000133 / 000037", () => {
  test("the live policies are the hoisted ones this test is meant to check", async () => {
    const rows = await database!.sql<{ table: string; qual: string }[]>`
      SELECT tablename AS table, qual FROM pg_policies
      WHERE schemaname = 'app' AND policyname = 'role_scope_visibility'
        AND tablename = ANY(${TABLES as unknown as string[]})
      ORDER BY tablename
    `;
    expect(rows.map((row) => row.table)).toEqual([...TABLES].sort());
    for (const row of rows) {
      expect(row.qual).toContain("SELECT app.current_user_is_school_admin()");
      if (row.table !== "materials") {
        expect(row.qual).toContain("SELECT app.current_user_is_attendance_officer()");
      }
    }
  });

  test("every caller sees exactly the rows the original predicate selects, on every table", async () => {
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
    console.info("[policy-equivalence] visible/total", JSON.stringify(matrix));
  });

  test("the comparison is not vacuous: scopes differ by caller and never cross schools", async () => {
    const [admin, teacher, parent, officer, , , adminB] = callers as [
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
      for (const caller of callers) {
        const other = caller.schoolId === a.schoolId ? allIds.b : allIds.a;
        const seen = await visibleNow(caller, table);
        expect(seen.filter((id) => other[table].includes(id))).toEqual([]);
      }
    }
    for (const table of ["students", "classes", "courses", "subjects"] as const) {
      expect(await visibleNow(officer, table)).toEqual(allIds.a[table]);
    }
    // Officers do not read materials (000037's predicate has no officer branch).
    expect(await visibleNow(officer, "materials")).toEqual([]);

    const teacherClasses = await visibleNow(teacher, "classes");
    expect(teacherClasses).toContain(own.teacherClass);
    expect(teacherClasses).not.toContain(own.otherClass);
    const teacherStudents = await visibleNow(teacher, "students");
    expect(teacherStudents).toContain(own.child);
    expect(teacherStudents.length).toBeLessThan(allIds.a.students.length);
    const teacherMaterials = await visibleNow(teacher, "materials");
    expect(teacherMaterials.length).toBeGreaterThan(0);
    expect(teacherMaterials.length).toBeLessThan(allIds.a.materials.length);

    expect(await visibleNow(parent, "students")).toEqual([own.child]);
  });
});
