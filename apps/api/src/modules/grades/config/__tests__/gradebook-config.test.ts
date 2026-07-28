/**
 * Gradebook configuration scope, weight validation, and audit tests (ST-112).
 *
 * Integration tests requiring a live PostgreSQL instance.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grades/config/__tests__
 */

// eslint-disable-next-line import-x/no-unresolved
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createAcademicYear,
  createClass,
  createCourse,
  createRoom,
  createSchool,
  createStudent,
  createSubject,
  createTeacher,
  createTerm,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../../../../../tests/harness";
import {
  assertCanManageGradebook,
  createCategory,
  createScheme,
  deleteCategory,
  getGradebookByClassId,
  getGradebookConfig,
  getOrCreateInheritedScheme,
  getScheme,
  linkScheme,
  listCategories,
  listSchemes,
  updateCategory,
  validateWeightTotal,
} from "../gradebook-config-service";

import type { Sql, TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

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

async function asUser<T>(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    result = await fn(tx);
  });
  return result as T;
}

/** A school with two teachers, a class, and a student enrolled. */
async function seedTenant(sql: Sql) {
  const school = await createSchool(sql);
  const teacherA = await createTeacher(sql, school.id);
  const teacherB = await createTeacher(sql, school.id);
  const year = await createAcademicYear(sql, school.id);
  const term = await createTerm(sql, school.id, year.id);
  const subject = await createSubject(sql, school.id);
  const course = await createCourse(sql, school.id, subject.id);
  const room = await createRoom(sql, school.id);

  const cls = await createClass(sql, school.id, {
    courseId: course.id,
    academicYearId: year.id,
    termId: term.id,
    leadTeacherId: teacherA.id,
    roomId: room.id,
  });

  const student = await createStudent(sql, school.id);

  return { school, teacherA, teacherB, class: cls, student, term, year, subject, course, room };
}

function auditRowsFor(
  sql: TransactionSql,
  schoolId: string,
  targetTable: string,
  targetId: string,
) {
  return sql<{ action: string; actor_id: string; old_values: unknown; new_values: unknown }[]>`
    SELECT action, actor_id, old_values, new_values
    FROM app.audit_logs
    WHERE school_id = ${schoolId} AND target_table = ${targetTable} AND target_id = ${targetId}
    ORDER BY created_at ASC
  `;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describeDb("authorization", () => {
  test("a teacher can manage the gradebook for a class they lead", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );

    const found = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id),
    );
    expect(found.id).toBe(gradebookId);
  });

  test("a teacher not assigned to the class cannot manage its gradebook", async () => {
    const t = await seedTenant(db.sql);

    await expect(
      asUser(t.school.id, t.teacherB.userId, (tx) => assertCanManageGradebook(tx, t.class.id)),
    ).rejects.toThrow(/not assigned to this class/i);
  });
});

// ---------------------------------------------------------------------------
// Assessment categories — weight validation
// ---------------------------------------------------------------------------

describeDb("category weight validation", () => {
  test("creates a category when active weights sum to 100%", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "Homework", weight: 100 }),
    );

    const { categories } = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      listCategories(tx, t.school.id, gradebookId),
    );
    expect(categories).toHaveLength(1);
    expect(Number(categories[0]!.weight)).toBe(100);
  });

  test("rejects creation when active weights exceed 100%", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );

    // First category: 60%
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "Midterm", weight: 60 }),
    );

    // Second at 50% would sum to 110% — rejected
    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        createCategory(tx, t.school.id, gradebookId, { name: "Final", weight: 50 }),
      ),
    ).rejects.toThrow(/must sum to 100/i);
  });

  test("rejects creation when active weights are below 100%", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        createCategory(tx, t.school.id, gradebookId, { name: "Quiz", weight: 50 }),
      ),
    ).rejects.toThrow(/must sum to 100/i);
  });

  test("accepts floating-point weights that sum to 100%", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "A", weight: 33.33 }),
    );
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "B", weight: 33.33 }),
    );
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "C", weight: 33.34 }),
    );

    const total = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      validateWeightTotal(tx, gradebookId, t.school.id),
    );
    expect(total).toBeCloseTo(100, 1);
  });

  test("update can bring weights back to 100%", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );

    const a = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "A", weight: 60 }),
    );
    const b = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "B", weight: 40 }),
    );

    // Update B from 40 to 30 — would sum to 90%, rejected
    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        updateCategory(tx, t.school.id, gradebookId, b.id, { weight: 30 }),
      ),
    ).rejects.toThrow(/must sum to 100/i);
  });

  test("update weight causes re-validation", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );

    const cat = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "All", weight: 100 }),
    );

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        updateCategory(tx, t.school.id, gradebookId, cat.id, { weight: 80 }),
      ),
    ).rejects.toThrow(/must sum to 100/i);
  });

  test("inactive categories are excluded from weight total", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "Active", weight: 100 }),
    );
    // Now deactivate it — total becomes 0, which is < 100
    const { categories } = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      listCategories(tx, t.school.id, gradebookId),
    );
    const active = categories.find((c) => c.is_active);
    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        updateCategory(tx, t.school.id, gradebookId, active!.id, { is_active: false }),
      ),
    ).rejects.toThrow(/must sum to 100/i);
  });
});

// ---------------------------------------------------------------------------
// Assessment categories — lifecycle
// ---------------------------------------------------------------------------

describeDb("category lifecycle", () => {
  test("listCategories returns categories ordered by sort_order", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "Final", weight: 50, sort_order: 2 }),
    );
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "Midterm", weight: 30, sort_order: 1 }),
    );
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "Homework", weight: 20, sort_order: 0 }),
    );

    const { categories } = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      listCategories(tx, t.school.id, gradebookId),
    );

    expect(categories.map((c) => c.name)).toEqual(["Homework", "Midterm", "Final"]);
  });

  test("deleteCategory removes a zero-weight category", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );

    // A(100%) + B(0%) = 100%
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "A", weight: 100 }),
    );
    const b = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "B", weight: 0 }),
    );

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      deleteCategory(tx, t.school.id, gradebookId, b.id),
    );

    const { categories } = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      listCategories(tx, t.school.id, gradebookId),
    );
    expect(categories.map((c) => c.name)).toEqual(["A"]);
  });

  test("deleteCategory rejects when remaining weights would not sum to 100%", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );

    const a = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "A", weight: 60 }),
    );
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "B", weight: 40 }),
    );

    // Deleting A would leave B at 40% — invalid
    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        deleteCategory(tx, t.school.id, gradebookId, a.id),
      ),
    ).rejects.toThrow(/must sum to 100/i);
  });
});

// ---------------------------------------------------------------------------
// Grading schemes — CRUD and versioning
// ---------------------------------------------------------------------------

describeDb("grading scheme CRUD", () => {
  test("creates a scheme with version 1 for a term", async () => {
    const t = await seedTenant(db.sql);

    const scheme = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createScheme(tx, t.school.id, t.teacherA.userId, {
        term_id: t.term.id,
        name: "Standard Letter",
        scheme_type: "letter",
        grade_boundaries: [
          { label: "A", min: 90, max: 100, gpa_points: 4.0 },
          { label: "F", min: 0, max: 59, gpa_points: 0.0 },
        ],
      }),
    );

    expect(scheme.version).toBe(1);
    expect(scheme.term_id).toBe(t.term.id);
    expect(scheme.is_inherited).toBe(false);
  });

  test("auto-increments version for subsequent schemes in the same term", async () => {
    const t = await seedTenant(db.sql);

    const v1 = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createScheme(tx, t.school.id, t.teacherA.userId, {
        term_id: t.term.id,
        name: "V1",
        scheme_type: "letter",
        grade_boundaries: [{ label: "A", min: 90, max: 100, gpa_points: 4.0 }],
      }),
    );
    const v2 = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createScheme(tx, t.school.id, t.teacherA.userId, {
        term_id: t.term.id,
        name: "V2",
        scheme_type: "letter",
        grade_boundaries: [{ label: "A", min: 90, max: 100, gpa_points: 4.0 }],
      }),
    );
    const v3 = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createScheme(tx, t.school.id, t.teacherA.userId, {
        term_id: t.term.id,
        name: "V3",
        scheme_type: "letter",
        grade_boundaries: [{ label: "A", min: 90, max: 100, gpa_points: 4.0 }],
      }),
    );

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
  });

  test("listSchemes returns all versions for a term, ordered descending", async () => {
    const t = await seedTenant(db.sql);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createScheme(tx, t.school.id, t.teacherA.userId, {
        term_id: t.term.id,
        name: "Initial",
        scheme_type: "letter",
        grade_boundaries: [{ label: "A", min: 90, max: 100, gpa_points: 4.0 }],
      }),
    );
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createScheme(tx, t.school.id, t.teacherA.userId, {
        term_id: t.term.id,
        name: "Revised",
        scheme_type: "letter",
        grade_boundaries: [{ label: "A", min: 85, max: 100, gpa_points: 4.0 }],
      }),
    );

    const schemes = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      listSchemes(tx, t.school.id, t.term.id),
    );

    expect(schemes).toHaveLength(2);
    expect(schemes[0]!.version).toBe(2);
    expect(schemes[1]!.version).toBe(1);
  });

  test("getScheme returns a scheme by ID", async () => {
    const t = await seedTenant(db.sql);

    const created = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createScheme(tx, t.school.id, t.teacherA.userId, {
        term_id: t.term.id,
        name: "Test",
        scheme_type: "gpa",
        grade_boundaries: [{ label: "A", min: 90, max: 100, gpa_points: 4.0 }],
      }),
    );

    const fetched = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getScheme(tx, t.school.id, created.id),
    );

    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe("Test");
  });

  test("getScheme returns 404 for nonexistent scheme", async () => {
    const t = await seedTenant(db.sql);

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        getScheme(tx, t.school.id, "00000000-0000-0000-0000-000000000000"),
      ),
    ).rejects.toThrow(/Grading scheme not found/i);
  });

  test("createScheme returns 404 for nonexistent term", async () => {
    const t = await seedTenant(db.sql);

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        createScheme(tx, t.school.id, t.teacherA.userId, {
          term_id: "00000000-0000-0000-0000-000000000000",
          name: "Bad",
          scheme_type: "letter",
          grade_boundaries: [{ label: "A", min: 90, max: 100, gpa_points: 4.0 }],
        }),
      ),
    ).rejects.toThrow(/Term not found/i);
  });
});

// ---------------------------------------------------------------------------
// Grading scheme — inheritance
// ---------------------------------------------------------------------------

describeDb("scheme inheritance", () => {
  test("getOrCreateInheritedScheme creates version 1 from school defaults", async () => {
    const t = await seedTenant(db.sql);

    const scheme = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getOrCreateInheritedScheme(tx, t.school.id, t.teacherA.userId, t.term.id),
    );

    expect(scheme.version).toBe(1);
    expect(scheme.is_inherited).toBe(true);
    expect(scheme.term_id).toBe(t.term.id);
  });

  test("getOrCreateInheritedScheme returns existing scheme if one exists", async () => {
    const t = await seedTenant(db.sql);

    const first = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getOrCreateInheritedScheme(tx, t.school.id, t.teacherA.userId, t.term.id),
    );

    const second = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getOrCreateInheritedScheme(tx, t.school.id, t.teacherA.userId, t.term.id),
    );

    expect(second.id).toBe(first.id);
  });
});

// ---------------------------------------------------------------------------
// Scheme linking
// ---------------------------------------------------------------------------

describeDb("scheme linking", () => {
  test("links a scheme to a gradebook", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );
    const scheme = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createScheme(tx, t.school.id, t.teacherA.userId, {
        term_id: t.term.id,
        name: "Test",
        scheme_type: "letter",
        grade_boundaries: [{ label: "A", min: 90, max: 100, gpa_points: 4.0 }],
      }),
    );

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      linkScheme(tx, t.school.id, gradebookId, scheme.id),
    );

    // Verify via getGradebookConfig
    const config = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookConfig(tx, t.school.id, gradebookId, t.teacherA.userId),
    );
    expect(config.grading_scheme?.id).toBe(scheme.id);
  });

  test("rejects linking a scheme from a different term", async () => {
    const t = await seedTenant(db.sql);
    const otherTerm = await createTerm(db.sql, t.school.id, t.year.id, { code: "T2" });

    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );
    const scheme = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createScheme(tx, t.school.id, t.teacherA.userId, {
        term_id: otherTerm.id,
        name: "Wrong term",
        scheme_type: "letter",
        grade_boundaries: [{ label: "A", min: 90, max: 100, gpa_points: 4.0 }],
      }),
    );

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        linkScheme(tx, t.school.id, gradebookId, scheme.id),
      ),
    ).rejects.toThrow(/does not belong to the gradebook/i);
  });
});

// ---------------------------------------------------------------------------
// Gradebook config — combined view
// ---------------------------------------------------------------------------

describeDb("gradebook config", () => {
  test("getGradebookConfig returns categories and scheme", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );

    // Add categories summing to 100
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "A", weight: 60 }),
    );
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "B", weight: 40 }),
    );

    const config = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookConfig(tx, t.school.id, gradebookId, t.teacherA.userId),
    );

    expect(config.gradebook_id).toBe(gradebookId);
    expect(config.categories).toHaveLength(2);
    expect(config.total_weight).toBe(100);
    // Scheme should be auto-inherited since none was linked
    expect(config.grading_scheme).not.toBeNull();
    expect(config.grading_scheme?.is_inherited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

describeDb("audit trail", () => {
  test("create, update, and delete category each write an audit row", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );

    const cat = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createCategory(tx, t.school.id, gradebookId, { name: "Audit", weight: 100 }),
    );

    const rows = await db.sql.begin((tx) =>
      auditRowsFor(tx, t.school.id, "assessment_categories", cat.id),
    );
    expect(rows.map((r) => r.action)).toEqual(["insert"]);
  });

  test("create and link scheme each write an audit row", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );
    const scheme = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createScheme(tx, t.school.id, t.teacherA.userId, {
        term_id: t.term.id,
        name: "Audit scheme",
        scheme_type: "letter",
        grade_boundaries: [{ label: "A", min: 90, max: 100, gpa_points: 4.0 }],
      }),
    );

    // Audit for scheme creation
    const schemeRows = await db.sql.begin((tx) =>
      auditRowsFor(tx, t.school.id, "grading_schemes", scheme.id),
    );
    expect(schemeRows.map((r) => r.action)).toEqual(["insert"]);

    // Link to gradebook
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      linkScheme(tx, t.school.id, gradebookId, scheme.id),
    );

    const linkRows = await db.sql.begin((tx) =>
      auditRowsFor(tx, t.school.id, "gradebooks", gradebookId),
    );
    expect(linkRows.map((r) => r.action)).toEqual(["update"]);
  });

  test("a failed mutation leaves no audit row behind", async () => {
    const t = await seedTenant(db.sql);
    const gradebookId = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getGradebookByClassId(tx, t.school.id, t.class.id).then((g) => g.id),
    );

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        createCategory(tx, t.school.id, gradebookId, { name: "Only", weight: 50 }),
      ),
    ).rejects.toThrow();

    const [{ count }] = await db.sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM app.audit_logs
      WHERE school_id = ${t.school.id} AND target_table = 'assessment_categories'
    `;
    expect(Number(count)).toBe(0);
  });
});
