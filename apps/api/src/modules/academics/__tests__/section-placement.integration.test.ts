/**
 * Grades & sections (000147): placing a student in a section enrolls them into its classes, moving
 * them withdraws them from the old section's, a class newly given a section picks up its students,
 * and timetable slots carry the section labels the apps show ("Grade 10 - C").
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/academics/__tests__/section-placement.integration.test.ts
 */

import { ERROR_CODES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  createClass as seedClass,
  createFullTenant,
  createStudent,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  type TenantFixture,
  type TestDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import { createClass, updateClass } from "../class-service";
import {
  createGradeLevel,
  createSection,
  deleteSection,
  placeStudentInSection,
  removeStudentFromSection,
} from "../section-service";
import {
  createTimetableSlot,
  createTimetableVersion,
  listTimetableSlots,
} from "../timetable-service";

import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
// Pinned single connections, as in material-toggle.integration.test.ts: a pooled `begin` after
// seeding can hang on bun + postgres.js.
let tenantClient: ReturnType<typeof postgres> | undefined;
let tenant: TenantFixture;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  tenant = await createFullTenant(db.sql);
  tenantClient = postgres(db.url, { max: 1, prepare: false });
});

afterAll(async () => {
  if (tenantClient) await tenantClient.end({ timeout: 1 });
  if (db?.cleanup) await db.cleanup();
});

/** Run as the school's ORG_ADMIN under RLS, the way the routes do. */
function asSchoolAdmin<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return withTenantTx(
    tenantClient!,
    { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id },
    fn,
  );
}

async function activeClassIds(studentId: string): Promise<string[]> {
  const rows = await asSchoolAdmin(
    (tx) => tx<{ class_id: string }[]>`
      SELECT class_id FROM app.enrollments
      WHERE student_id = ${studentId} AND status = 'active'
      ORDER BY class_id
    `,
  );
  return rows.map((row) => row.class_id);
}

async function newClass(code: string, sectionId: string | null = null): Promise<string> {
  const cls = await asSchoolAdmin((tx) =>
    createClass(tx, tenant.schoolId, {
      course_id: tenant.course.id,
      academic_year_id: tenant.academicYear.id,
      term_id: tenant.term.id,
      lead_teacher_id: tenant.teachers[0]!.id,
      section_id: sectionId,
      code,
      status: "active",
    }),
  );
  return cls.id;
}

describeDb("section placement", () => {
  test("places, moves, and removes a student, following the section's classes", async () => {
    const { sectionC, sectionD } = await asSchoolAdmin(async (tx) => {
      const grade = await createGradeLevel(tx, tenant.schoolId, {
        name: "Grade 10",
        sort_order: 10,
      });
      const c = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: grade.id,
        name: "C",
      });
      const d = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: grade.id,
        name: "D",
      });
      return { sectionC: c, sectionD: d };
    });
    expect(sectionC.grade_level_name).toBe("Grade 10");

    const mathC = await newClass("MATH-10C", sectionC.id);
    const scienceC = await newClass("SCI-10C", sectionC.id);
    const mathD = await newClass("MATH-10D", sectionD.id);
    const student = await createStudent(db.sql, tenant.schoolId, { firstName: "Sara" });

    const placed = await asSchoolAdmin((tx) =>
      placeStudentInSection(tx, tenant.schoolId, sectionC.id, student.id),
    );
    expect(placed.student.first_name).toBe("Sara");
    expect([...placed.enrolled_class_ids].sort()).toEqual([mathC, scienceC].sort());
    expect(await activeClassIds(student.id)).toEqual([mathC, scienceC].sort());

    // Placing again is a no-op for enrollments.
    const again = await asSchoolAdmin((tx) =>
      placeStudentInSection(tx, tenant.schoolId, sectionC.id, student.id),
    );
    expect(again.enrolled_class_ids).toEqual([]);

    // A class newly added to the section enrolls the students already placed there.
    const englishC = await newClass("ENG-10C");
    await asSchoolAdmin((tx) =>
      updateClass(tx, tenant.schoolId, englishC, { section_id: sectionC.id }),
    );
    expect(await activeClassIds(student.id)).toEqual([mathC, scienceC, englishC].sort());

    // Moving to D withdraws from C's classes.
    await asSchoolAdmin((tx) =>
      placeStudentInSection(tx, tenant.schoolId, sectionD.id, student.id),
    );
    expect(await activeClassIds(student.id)).toEqual([mathD]);

    // A section with classes or students cannot be deleted.
    await expect(
      asSchoolAdmin((tx) => deleteSection(tx, tenant.schoolId, sectionD.id)),
    ).rejects.toMatchObject({ code: ERROR_CODES.SECTION_IN_USE });

    await asSchoolAdmin((tx) =>
      removeStudentFromSection(tx, tenant.schoolId, sectionD.id, student.id),
    );
    expect(await activeClassIds(student.id)).toEqual([]);
  });

  test("skips a full class instead of failing the placement", async () => {
    const section = await asSchoolAdmin(async (tx) => {
      const grade = await createGradeLevel(tx, tenant.schoolId, {
        name: "Grade 11",
        sort_order: 11,
      });
      return createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: grade.id,
        name: "A",
      });
    });
    const fullClass = await seedClass(db.sql, tenant.schoolId, {
      courseId: tenant.course.id,
      academicYearId: tenant.academicYear.id,
      termId: tenant.term.id,
      leadTeacherId: tenant.teachers[0]!.id,
      roomId: tenant.room.id,
      code: "FULL-11A",
    });
    await asSchoolAdmin(async (tx) => {
      await updateClass(tx, tenant.schoolId, fullClass.id, { capacity: 1, section_id: section.id });
    });
    const first = await createStudent(db.sql, tenant.schoolId);
    const second = await createStudent(db.sql, tenant.schoolId);

    await asSchoolAdmin((tx) => placeStudentInSection(tx, tenant.schoolId, section.id, first.id));
    const result = await asSchoolAdmin((tx) =>
      placeStudentInSection(tx, tenant.schoolId, section.id, second.id),
    );
    expect(result.enrolled_class_ids).toEqual([]);
    expect(result.skipped_class_ids).toEqual([fullClass.id]);
  });

  test("rejects a section from another academic year on a class", async () => {
    const otherYear = await asSchoolAdmin(async (tx) => {
      const [year] = await tx<{ id: string }[]>`
        INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
        VALUES (${tenant.schoolId}, 'AY-NEXT', 'Next year', '2099-08-01', '2100-06-30', 'planned')
        RETURNING id
      `;
      const grade = await createGradeLevel(tx, tenant.schoolId, {
        name: "Grade 12",
        sort_order: 12,
      });
      return createSection(tx, tenant.schoolId, {
        academic_year_id: year!.id,
        grade_level_id: grade.id,
        name: "A",
      });
    });

    await expect(newClass("WRONG-YEAR", otherYear.id)).rejects.toMatchObject({ status: 404 });
  });

  test("labels timetable slots with their grade and section, and filters by section", async () => {
    const { section, versionId } = await asSchoolAdmin(async (tx) => {
      const grade = await createGradeLevel(tx, tenant.schoolId, { name: "Grade 9", sort_order: 9 });
      const created = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: grade.id,
        name: "B",
      });
      const version = await createTimetableVersion(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        term_id: tenant.term.id,
        name: "Sections draft",
      });
      return { section: created, versionId: version.id };
    });
    const inSection = await newClass("ART-9B", section.id);
    const elective = await newClass("ELECTIVE");

    const slot = await asSchoolAdmin((tx) =>
      createTimetableSlot(tx, tenant.schoolId, versionId, {
        class_id: inSection,
        teacher_id: tenant.teachers[0]!.id,
        room_id: tenant.room.id,
        weekday: 1,
        period: 1,
      }),
    );
    expect(slot).toMatchObject({
      section_id: section.id,
      section_name: "B",
      grade_level_name: "Grade 9",
    });

    await asSchoolAdmin((tx) =>
      // No room: rooms are optional since 000148.
      createTimetableSlot(tx, tenant.schoolId, versionId, {
        class_id: elective,
        teacher_id: tenant.teachers[0]!.id,
        weekday: 1,
        period: 2,
      }),
    );

    const all = await asSchoolAdmin((tx) =>
      listTimetableSlots(tx, tenant.schoolId, versionId, { limit: 100, offset: 0 }),
    );
    expect(all.total).toBe(2);
    expect(all.rows.find((row) => row.class_id === elective)?.section_id).toBeNull();
    expect(all.rows.find((row) => row.class_id === elective)?.room_id).toBeNull();

    const filtered = await asSchoolAdmin((tx) =>
      listTimetableSlots(tx, tenant.schoolId, versionId, {
        limit: 100,
        offset: 0,
        section_id: section.id,
      }),
    );
    expect(filtered.rows.map((row) => row.class_id)).toEqual([inSection]);
  });
});
