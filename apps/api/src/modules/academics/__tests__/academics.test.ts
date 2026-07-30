/**
 * Academic year & term management tests (ST-091).
 *
 * Integration tests that require a live PostgreSQL instance. Each test creates its own
 * school and academic data via the test harness factories, then exercises the service
 * functions directly within a tenant transaction.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/academics/__tests__
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  createTestDatabase,
  migrateDatabase,
  createSchool,
  integrationEnabled,
  type TestDatabase,
} from "../../../../tests/harness";
import {
  listAcademicYears,
  getAcademicYear,
  createAcademicYear as createYearService,
  updateAcademicYear,
  deleteAcademicYear,
} from "../academic-year-service";
import {
  listCourses,
  getCourse,
  createCourse as createCourseService,
  updateCourse,
  deleteCourse,
} from "../course-service";
import { rolloverAcademicYear } from "../rollover-service";
import {
  listSubjects,
  getSubject,
  createSubject as createSubjectService,
  updateSubject,
  deleteSubject,
} from "../subject-service";
import {
  listTerms,
  getTerm,
  createTerm as createTermService,
  updateTerm,
  deleteTerm,
} from "../term-service";

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Skip when no database is available
// ---------------------------------------------------------------------------

const describeDb = integrationEnabled ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
});

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTx<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`SELECT set_config('role', 'studafy_app', true)`;
    result = await fn(tx);
  });
  return result as T;
}

// ---------------------------------------------------------------------------
// Academic year service
// ---------------------------------------------------------------------------

describeDb("academic year service", () => {
  test("createAcademicYear inserts a row and returns it", async () => {
    const school = await createSchool(db.sql);
    const year = await withTx((tx) =>
      createYearService(tx, school.id, {
        code: "2025-2026",
        name: "Academic Year 2025-2026",
        starts_on: "2025-09-01",
        ends_on: "2026-06-30",
      }),
    );

    expect(year).toBeDefined();
    expect(year.code).toBe("2025-2026");
    expect(year.name).toBe("Academic Year 2025-2026");
    expect(year.status).toBe("planned");
  });

  test("createAcademicYear rejects overlapping active year", async () => {
    const school = await createSchool(db.sql);

    // Create an active year first
    await withTx((tx) =>
      createYearService(tx, school.id, {
        code: "AY-ACTIVE",
        name: "Active Year",
        starts_on: "2025-01-01",
        ends_on: "2025-12-31",
        status: "active",
      }),
    );

    // Attempting to create another active year should fail
    await expect(
      withTx((tx) =>
        createYearService(tx, school.id, {
          code: "AY-ACTIVE-2",
          name: "Active Year 2",
          starts_on: "2025-01-01",
          ends_on: "2025-12-31",
          status: "active",
        }),
      ),
    ).rejects.toThrow();
  });

  test("getAcademicYear returns undefined for non-existent ID", async () => {
    const school = await createSchool(db.sql);
    const result = await withTx((tx) =>
      getAcademicYear(tx, school.id, "00000000-0000-0000-0000-000000000000"),
    );
    expect(result).toBeUndefined();
  });

  test("listAcademicYears returns paginated results", async () => {
    const school = await createSchool(db.sql);

    // Create 3 years
    for (let i = 0; i < 3; i++) {
      await withTx((tx) =>
        createYearService(tx, school.id, {
          code: `AY-${2020 + i}`,
          name: `Year ${2020 + i}`,
          starts_on: `${2020 + i}-01-01`,
          ends_on: `${2020 + i}-12-31`,
        }),
      );
    }

    const { rows, total } = await withTx((tx) =>
      listAcademicYears(tx, school.id, { limit: 2, offset: 0 }),
    );
    expect(total).toBe(3);
    expect(rows.length).toBe(2);
  });

  test("updateAcademicYear modifies fields", async () => {
    const school = await createSchool(db.sql);
    const year = await withTx((tx) =>
      createYearService(tx, school.id, {
        code: "AY-UPDATE",
        name: "Original Name",
        starts_on: "2025-01-01",
        ends_on: "2025-12-31",
      }),
    );

    const updated = await withTx((tx) =>
      updateAcademicYear(tx, school.id, year.id, { name: "Updated Name" }),
    );
    expect(updated.name).toBe("Updated Name");
    expect(updated.code).toBe("AY-UPDATE");
  });

  test("deleteAcademicYear removes a planned year", async () => {
    const school = await createSchool(db.sql);
    const year = await withTx((tx) =>
      createYearService(tx, school.id, {
        code: "AY-DELETE",
        name: "To Delete",
        starts_on: "2025-01-01",
        ends_on: "2025-12-31",
      }),
    );

    await withTx((tx) => deleteAcademicYear(tx, school.id, year.id));
    const result = await withTx((tx) => getAcademicYear(tx, school.id, year.id));
    expect(result).toBeUndefined();
  });

  test("deleteAcademicYear rejects non-planned years", async () => {
    const school = await createSchool(db.sql);
    const year = await withTx((tx) =>
      createYearService(tx, school.id, {
        code: "AY-ACTIVE-NO-DELETE",
        name: "Active Year",
        starts_on: "2025-01-01",
        ends_on: "2025-12-31",
        status: "active",
      }),
    );

    await expect(withTx((tx) => deleteAcademicYear(tx, school.id, year.id))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Term service
// ---------------------------------------------------------------------------

describeDb("term service", () => {
  test("createTerm inserts a term within its academic year", async () => {
    const school = await createSchool(db.sql);
    const year = await withTx((tx) =>
      createYearService(tx, school.id, {
        code: "AY-TERM",
        name: "Year for Terms",
        starts_on: "2025-01-01",
        ends_on: "2025-12-31",
      }),
    );

    const term = await withTx((tx) =>
      createTermService(tx, school.id, {
        academic_year_id: year.id,
        code: "T1",
        name: "Term 1",
        sequence_number: 1,
        starts_on: "2025-01-01",
        ends_on: "2025-06-30",
      }),
    );

    expect(term).toBeDefined();
    expect(term.code).toBe("T1");
    expect(term.academic_year_id).toBe(year.id);
  });

  test("getTerm returns undefined for non-existent ID", async () => {
    const school = await createSchool(db.sql);
    const result = await withTx((tx) =>
      getTerm(tx, school.id, "00000000-0000-0000-0000-000000000000"),
    );
    expect(result).toBeUndefined();
  });

  test("listTerms returns terms for a specific academic year", async () => {
    const school = await createSchool(db.sql);
    const year = await withTx((tx) =>
      createYearService(tx, school.id, {
        code: "AY-LIST-TERM",
        name: "Year",
        starts_on: "2025-01-01",
        ends_on: "2025-12-31",
      }),
    );

    await withTx((tx) =>
      createTermService(tx, school.id, {
        academic_year_id: year.id,
        code: "T1",
        name: "Term 1",
        sequence_number: 1,
        starts_on: "2025-01-01",
        ends_on: "2025-06-30",
      }),
    );

    await withTx((tx) =>
      createTermService(tx, school.id, {
        academic_year_id: year.id,
        code: "T2",
        name: "Term 2",
        sequence_number: 2,
        starts_on: "2025-07-01",
        ends_on: "2025-12-31",
      }),
    );

    const { rows, total } = await withTx((tx) =>
      listTerms(tx, school.id, year.id, { limit: 10, offset: 0 }),
    );
    expect(total).toBe(2);
    expect(rows.length).toBe(2);
    expect(rows[0]!.sequence_number).toBeLessThan(rows[1]!.sequence_number);
  });

  test("updateTerm modifies fields", async () => {
    const school = await createSchool(db.sql);
    const year = await withTx((tx) =>
      createYearService(tx, school.id, {
        code: "AY-UPDATE-TERM",
        name: "Year",
        starts_on: "2025-01-01",
        ends_on: "2025-12-31",
      }),
    );
    const term = await withTx((tx) =>
      createTermService(tx, school.id, {
        academic_year_id: year.id,
        code: "T1",
        name: "Original",
        sequence_number: 1,
        starts_on: "2025-01-01",
        ends_on: "2025-06-30",
      }),
    );

    const updated = await withTx((tx) =>
      updateTerm(tx, school.id, term.id, { name: "Updated Term" }),
    );
    expect(updated.name).toBe("Updated Term");
  });

  test("deleteTerm removes a planned term", async () => {
    const school = await createSchool(db.sql);
    const year = await withTx((tx) =>
      createYearService(tx, school.id, {
        code: "AY-DEL-TERM",
        name: "Year",
        starts_on: "2025-01-01",
        ends_on: "2025-12-31",
      }),
    );
    const term = await withTx((tx) =>
      createTermService(tx, school.id, {
        academic_year_id: year.id,
        code: "T1",
        name: "To Delete",
        sequence_number: 1,
        starts_on: "2025-01-01",
        ends_on: "2025-06-30",
      }),
    );

    await withTx((tx) => deleteTerm(tx, school.id, term.id));
    const result = await withTx((tx) => getTerm(tx, school.id, term.id));
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rollover service
// ---------------------------------------------------------------------------

describeDb("rollover service", () => {
  test("rollover activates target year and closes prior active year", async () => {
    const school = await createSchool(db.sql);

    // Create an active year
    const activeYear = await withTx((tx) =>
      createYearService(tx, school.id, {
        code: "AY-CURRENT",
        name: "Current Year",
        starts_on: "2024-09-01",
        ends_on: "2025-06-30",
        status: "active",
      }),
    );

    // Create a planned target year
    const targetYear = await withTx((tx) =>
      createYearService(tx, school.id, {
        code: "AY-NEXT",
        name: "Next Year",
        starts_on: "2025-09-01",
        ends_on: "2026-06-30",
        status: "planned",
      }),
    );

    const result = await rolloverAcademicYear(db.sql, { schoolId: school.id }, targetYear.id);

    expect(result.prior_year_id).toBe(activeYear.id);
    expect(result.prior_year_status).toBe("closed");
    expect(result.new_year_id).toBe(targetYear.id);
    expect(result.new_year_status).toBe("active");
    expect(result.enrollments_archived).toBe(0);

    // Verify the prior year is now closed
    const priorAfter = await withTx((tx) => getAcademicYear(tx, school.id, activeYear.id));
    expect(priorAfter!.status).toBe("closed");

    // Verify the target year is now active
    const targetAfter = await withTx((tx) => getAcademicYear(tx, school.id, targetYear.id));
    expect(targetAfter!.status).toBe("active");
  });

  test("rollover works when no prior active year exists (first activation)", async () => {
    const school = await createSchool(db.sql);

    const targetYear = await withTx((tx) =>
      createYearService(tx, school.id, {
        code: "AY-FIRST",
        name: "First Year",
        starts_on: "2025-01-01",
        ends_on: "2025-12-31",
      }),
    );

    const result = await rolloverAcademicYear(db.sql, { schoolId: school.id }, targetYear.id);

    expect(result.prior_year_id).toBeNull();
    expect(result.prior_year_status).toBeNull();
    expect(result.new_year_id).toBe(targetYear.id);
    expect(result.new_year_status).toBe("active");
    expect(result.enrollments_archived).toBe(0);
  });

  test("rollover rejects if target year is already active", async () => {
    const school = await createSchool(db.sql);

    const activeYear = await withTx((tx) =>
      createYearService(tx, school.id, {
        code: "AY-ALREADY-ACTIVE",
        name: "Already Active",
        starts_on: "2025-01-01",
        ends_on: "2025-12-31",
        status: "active",
      }),
    );

    await expect(
      rolloverAcademicYear(db.sql, { schoolId: school.id }, activeYear.id),
    ).rejects.toThrow();
  });

  test("rollover rejects non-existent year", async () => {
    const school = await createSchool(db.sql);

    await expect(
      rolloverAcademicYear(db.sql, { schoolId: school.id }, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Subject service
// ---------------------------------------------------------------------------

describeDb("subject service", () => {
  test("createSubject inserts a row and returns it", async () => {
    const school = await createSchool(db.sql);
    const subject = await withTx((tx) =>
      createSubjectService(tx, school.id, {
        code: "MATH",
        name: "Mathematics",
        description: "Core math curriculum",
      }),
    );

    expect(subject).toBeDefined();
    expect(subject.code).toBe("MATH");
    expect(subject.name).toBe("Mathematics");
    expect(subject.description).toBe("Core math curriculum");
    expect(subject.status).toBe("draft");
  });

  test("getSubject returns undefined for non-existent ID", async () => {
    const school = await createSchool(db.sql);
    const result = await withTx((tx) =>
      getSubject(tx, school.id, "00000000-0000-0000-0000-000000000000"),
    );
    expect(result).toBeUndefined();
  });

  test("listSubjects returns paginated results", async () => {
    const school = await createSchool(db.sql);

    await withTx((tx) => createSubjectService(tx, school.id, { code: "PHY", name: "Physics" }));
    await withTx((tx) => createSubjectService(tx, school.id, { code: "CHEM", name: "Chemistry" }));
    await withTx((tx) => createSubjectService(tx, school.id, { code: "BIO", name: "Biology" }));

    const { rows, total } = await withTx((tx) =>
      listSubjects(tx, school.id, { limit: 2, offset: 0 }),
    );
    expect(total).toBe(3);
    expect(rows.length).toBe(2);
  });

  test("updateSubject modifies fields", async () => {
    const school = await createSchool(db.sql);
    const subject = await withTx((tx) =>
      createSubjectService(tx, school.id, { code: "HIST", name: "History" }),
    );

    const updated = await withTx((tx) =>
      updateSubject(tx, school.id, subject.id, { name: "World History" }),
    );
    expect(updated.name).toBe("World History");
    expect(updated.code).toBe("HIST");
  });

  test("deleteSubject hard-deletes an unreferenced subject", async () => {
    const school = await createSchool(db.sql);
    const subject = await withTx((tx) =>
      createSubjectService(tx, school.id, { code: "DEL", name: "To Delete" }),
    );

    const result = await withTx((tx) => deleteSubject(tx, school.id, subject.id));
    expect(result.deleted).toBe(true);

    const gone = await withTx((tx) => getSubject(tx, school.id, subject.id));
    expect(gone).toBeUndefined();
  });

  test("deleteSubject archives a subject that has courses", async () => {
    const school = await createSchool(db.sql);
    const subject = await withTx((tx) =>
      createSubjectService(tx, school.id, { code: "ARCH", name: "To Archive" }),
    );

    await withTx((tx) =>
      createCourseService(tx, school.id, {
        subject_id: subject.id,
        code: "C1",
        name: "Course 1",
      }),
    );

    const result = await withTx((tx) => deleteSubject(tx, school.id, subject.id));
    expect(result.deleted).toBe(false);

    const archived = await withTx((tx) => getSubject(tx, school.id, subject.id));
    expect(archived).toBeDefined();
    expect(archived!.status).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// Course service
// ---------------------------------------------------------------------------

describeDb("course service", () => {
  test("createCourse inserts a row and returns it", async () => {
    const school = await createSchool(db.sql);
    const subject = await withTx((tx) =>
      createSubjectService(tx, school.id, { code: "MATH", name: "Mathematics" }),
    );

    const course = await withTx((tx) =>
      createCourseService(tx, school.id, {
        subject_id: subject.id,
        code: "CALC101",
        name: "Calculus I",
        description: "Intro calculus",
        credit_hours: 3.5,
      }),
    );

    expect(course).toBeDefined();
    expect(course.code).toBe("CALC101");
    expect(course.name).toBe("Calculus I");
    expect(course.description).toBe("Intro calculus");
    expect(course.credit_hours).toBe(3.5);
    expect(course.subject_id).toBe(subject.id);
    expect(course.status).toBe("draft");
  });

  test("createCourse rejects non-existent subject", async () => {
    const school = await createSchool(db.sql);

    await expect(
      withTx((tx) =>
        createCourseService(tx, school.id, {
          subject_id: "00000000-0000-0000-0000-000000000000",
          code: "X",
          name: "X",
        }),
      ),
    ).rejects.toThrow();
  });

  test("getCourse returns undefined for non-existent ID", async () => {
    const school = await createSchool(db.sql);
    const result = await withTx((tx) =>
      getCourse(tx, school.id, "00000000-0000-0000-0000-000000000000"),
    );
    expect(result).toBeUndefined();
  });

  test("listCourses returns courses for a specific subject", async () => {
    const school = await createSchool(db.sql);
    const subject = await withTx((tx) =>
      createSubjectService(tx, school.id, { code: "SCI", name: "Science" }),
    );

    await withTx((tx) =>
      createCourseService(tx, school.id, {
        subject_id: subject.id,
        code: "PHY101",
        name: "Physics I",
      }),
    );
    await withTx((tx) =>
      createCourseService(tx, school.id, {
        subject_id: subject.id,
        code: "PHY102",
        name: "Physics II",
      }),
    );

    const { rows, total } = await withTx((tx) =>
      listCourses(tx, school.id, subject.id, { limit: 10, offset: 0 }),
    );
    expect(total).toBe(2);
    expect(rows.length).toBe(2);
  });

  test("updateCourse modifies fields", async () => {
    const school = await createSchool(db.sql);
    const subject = await withTx((tx) =>
      createSubjectService(tx, school.id, { code: "ENG", name: "English" }),
    );
    const course = await withTx((tx) =>
      createCourseService(tx, school.id, {
        subject_id: subject.id,
        code: "ENG101",
        name: "English I",
      }),
    );

    const updated = await withTx((tx) =>
      updateCourse(tx, school.id, course.id, {
        name: "English Composition I",
        credit_hours: 2.5,
      }),
    );
    expect(updated.name).toBe("English Composition I");
    expect(updated.credit_hours).toBe(2.5);
  });

  test("deleteCourse hard-deletes an unreferenced course", async () => {
    const school = await createSchool(db.sql);
    const subject = await withTx((tx) =>
      createSubjectService(tx, school.id, { code: "DEL", name: "To Delete" }),
    );
    const course = await withTx((tx) =>
      createCourseService(tx, school.id, {
        subject_id: subject.id,
        code: "DC1",
        name: "Delete Me",
      }),
    );

    const result = await withTx((tx) => deleteCourse(tx, school.id, course.id));
    expect(result.deleted).toBe(true);

    const gone = await withTx((tx) => getCourse(tx, school.id, course.id));
    expect(gone).toBeUndefined();
  });

  test("deleteCourse archives a course that has classes", async () => {
    const school = await createSchool(db.sql);
    const subject = await withTx((tx) =>
      createSubjectService(tx, school.id, { code: "ARCH", name: "To Archive" }),
    );
    const course = await withTx((tx) =>
      createCourseService(tx, school.id, {
        subject_id: subject.id,
        code: "AC1",
        name: "Archive Me",
      }),
    );

    // Create a class referencing this course
    const year = await withTx((tx) =>
      createYearService(tx, school.id, {
        code: "AY-TEST",
        name: "Test Year",
        starts_on: "2025-01-01",
        ends_on: "2025-12-31",
      }),
    );
    const term = await withTx((tx) =>
      createTermService(tx, school.id, {
        academic_year_id: year.id,
        code: "T1",
        name: "Term 1",
        sequence_number: 1,
        starts_on: "2025-01-01",
        ends_on: "2025-06-30",
      }),
    );

    // Directly insert a class row (factory requires teacher/room, so raw SQL is simpler here)
    await db.sql`
      INSERT INTO app.classes (school_id, course_id, academic_year_id, term_id,
        lead_teacher_id, room_id, code, capacity, status)
      VALUES (${school.id}, ${course.id}, ${year.id}, ${term.id},
        gen_random_uuid(), gen_random_uuid(), 'CLS-TEST', 30, 'planned'::app.class_status)
    `;

    const result = await withTx((tx) => deleteCourse(tx, school.id, course.id));
    expect(result.deleted).toBe(false);

    const archived = await withTx((tx) => getCourse(tx, school.id, course.id));
    expect(archived).toBeDefined();
    expect(archived!.status).toBe("archived");
  });
});
