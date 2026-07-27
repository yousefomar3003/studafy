/**
 * Assignment scope, visibility, and audit tests (ST-103).
 *
 * Integration tests requiring a live PostgreSQL instance, in the style of
 * modules/academics/__tests__/academics.test.ts. They are the only tests that can demonstrate the
 * guarantees this ticket is actually about, because those guarantees are enforced partly by RLS
 * policies and SECURITY DEFINER helpers that do not exist outside a database.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/academics/assignments/__tests__
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createAcademicYear,
  createClass,
  createCourse,
  createEnrollment,
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
  createAssignment,
  deleteAssignment,
  getAssignment,
  listAssignments,
  updateAssignment,
} from "../assignment-service";

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

/**
 * Run inside a tenant transaction acting as a specific user.
 *
 * The GUCs are the whole point. app.school_id drives tenant_isolation; app.user_id drives
 * app.scope_user_id(), which every role-scope helper and the service's own visibility predicate
 * resolve the caller through. Running as studafy_app rather than studafy_admin is equally
 * load-bearing: the restrictive policies are declared TO studafy_app and simply do not apply to
 * the owner, so a test that forgot this would pass while exercising no isolation at all.
 */
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

/** A school with two teachers, two classes, and one student enrolled in the first class. */
async function seedTenant(sql: Sql) {
  const school = await createSchool(sql);
  const teacherA = await createTeacher(sql, school.id);
  const teacherB = await createTeacher(sql, school.id);
  const year = await createAcademicYear(sql, school.id);
  const term = await createTerm(sql, school.id, year.id);
  const subject = await createSubject(sql, school.id);
  const otherSubject = await createSubject(sql, school.id);
  const course = await createCourse(sql, school.id, subject.id);
  const otherCourse = await createCourse(sql, school.id, otherSubject.id);
  const room = await createRoom(sql, school.id);

  const classA = await createClass(sql, school.id, {
    courseId: course.id,
    academicYearId: year.id,
    termId: term.id,
    leadTeacherId: teacherA.id,
    roomId: room.id,
  });
  const classB = await createClass(sql, school.id, {
    courseId: otherCourse.id,
    academicYearId: year.id,
    termId: term.id,
    leadTeacherId: teacherB.id,
    roomId: room.id,
  });

  const student = await createStudent(sql, school.id);
  await createEnrollment(sql, school.id, classA.id, student.id);

  return {
    school,
    teacherA,
    teacherB,
    classA,
    classB,
    student,
    subject,
    otherSubject,
    year,
    term,
    room,
  };
}

function futureIso(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

function draftBody(classId: string, overrides: Record<string, unknown> = {}) {
  return {
    class_id: classId,
    title: "Problem Set 1",
    due_at: futureIso(7),
    max_score: 100,
    allow_late_submission: false,
    status: "draft" as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Teacher scope
// ---------------------------------------------------------------------------

describeDb("teacher class scope", () => {
  test("a teacher can create an assignment for a class they lead", async () => {
    const t = await seedTenant(db.sql);

    const assignment = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(tx, t.school.id, t.teacherA.userId, draftBody(t.classA.id)),
    );

    expect(assignment.class_id).toBe(t.classA.id);
    expect(assignment.status).toBe("draft");
    // Projected through classes -> courses rather than stored on the assignment.
    expect(assignment.subject_id).toBe(t.subject.id);
  });

  test("a teacher cannot create an assignment for another teacher's class", async () => {
    const t = await seedTenant(db.sql);

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        createAssignment(tx, t.school.id, t.teacherA.userId, draftBody(t.classB.id)),
      ),
    ).rejects.toThrow(/not assigned to this class/i);
  });

  test("a teacher cannot update another teacher's assignment", async () => {
    const t = await seedTenant(db.sql);

    const assignment = await asUser(t.school.id, t.teacherB.userId, (tx) =>
      createAssignment(tx, t.school.id, t.teacherB.userId, draftBody(t.classB.id)),
    );

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        updateAssignment(tx, t.school.id, t.teacherA.userId, assignment.id, { title: "Hijacked" }),
      ),
    ).rejects.toThrow(/not assigned to this class/i);
  });

  test("a teacher cannot delete another teacher's assignment", async () => {
    const t = await seedTenant(db.sql);

    const assignment = await asUser(t.school.id, t.teacherB.userId, (tx) =>
      createAssignment(tx, t.school.id, t.teacherB.userId, draftBody(t.classB.id)),
    );

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        deleteAssignment(tx, t.school.id, t.teacherA.userId, assignment.id),
      ),
    ).rejects.toThrow(/not assigned to this class/i);
  });

  test("a co-teacher holding a timetable slot for the class may manage it", async () => {
    // app.teaches_class accepts the lead teacher OR any teacher with a slot, which is how a
    // substitute or co-teacher works without a second membership table. Asserting it here keeps
    // the service honest about delegating to that helper rather than checking lead_teacher_id.
    const t = await seedTenant(db.sql);

    await db.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.school_id', ${t.school.id}, true)`;

      const [version] = await tx<{ id: string }[]>`
        INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name)
        VALUES (${t.school.id}, ${t.year.id}, ${t.term.id}, 'Co-teacher fixture')
        RETURNING id
      `;

      await tx`
        INSERT INTO app.timetable_slots
          (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
        VALUES (${t.school.id}, ${version!.id}, ${t.classA.id}, ${t.teacherB.id}, ${t.room.id}, 1, 1)
      `;
    });

    const assignment = await asUser(t.school.id, t.teacherB.userId, (tx) =>
      createAssignment(tx, t.school.id, t.teacherB.userId, draftBody(t.classA.id)),
    );

    expect(assignment.class_id).toBe(t.classA.id);
  });
});

// ---------------------------------------------------------------------------
// Student visibility
// ---------------------------------------------------------------------------

describeDb("student visibility", () => {
  test("an actively enrolled student sees published assignments", async () => {
    const t = await seedTenant(db.sql);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(
        tx,
        t.school.id,
        t.teacherA.userId,
        draftBody(t.classA.id, { status: "published", title: "Visible" }),
      ),
    );

    const { rows } = await asUser(t.school.id, t.student.userId, (tx) =>
      listAssignments(tx, t.school.id, { limit: 20 }),
    );

    expect(rows.map((row) => row.title)).toEqual(["Visible"]);
  });

  test("a student never sees a draft", async () => {
    // RLS alone would show this: role_scope_visibility has no status predicate. The service's
    // visibility predicate is what withholds a teacher's unfinished work.
    const t = await seedTenant(db.sql);

    const draft = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(tx, t.school.id, t.teacherA.userId, draftBody(t.classA.id)),
    );

    const { rows } = await asUser(t.school.id, t.student.userId, (tx) =>
      listAssignments(tx, t.school.id, { limit: 20 }),
    );
    expect(rows).toHaveLength(0);

    const direct = await asUser(t.school.id, t.student.userId, (tx) =>
      getAssignment(tx, t.school.id, draft.id),
    );
    expect(direct).toBeNull();
  });

  test("the teacher does see their own draft", async () => {
    const t = await seedTenant(db.sql);

    const draft = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(tx, t.school.id, t.teacherA.userId, draftBody(t.classA.id)),
    );

    const seen = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getAssignment(tx, t.school.id, draft.id),
    );

    expect(seen?.id).toBe(draft.id);
  });

  test("a withdrawn student sees nothing", async () => {
    // The gap this ticket closes: app.can_read_class accepts any enrollment row, so RLS alone
    // would keep showing coursework to a student who left the class.
    const t = await seedTenant(db.sql);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(
        tx,
        t.school.id,
        t.teacherA.userId,
        draftBody(t.classA.id, { status: "published" }),
      ),
    );

    await db.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.school_id', ${t.school.id}, true)`;
      await tx`
        UPDATE app.enrollments
        SET status = 'withdrawn', withdrawn_at = CURRENT_TIMESTAMP
        WHERE school_id = ${t.school.id} AND class_id = ${t.classA.id}
          AND student_id = ${t.student.id}
      `;
    });

    const { rows } = await asUser(t.school.id, t.student.userId, (tx) =>
      listAssignments(tx, t.school.id, { limit: 20 }),
    );

    expect(rows).toHaveLength(0);
  });

  test("a student sees nothing for a class they are not enrolled in", async () => {
    const t = await seedTenant(db.sql);

    await asUser(t.school.id, t.teacherB.userId, (tx) =>
      createAssignment(
        tx,
        t.school.id,
        t.teacherB.userId,
        draftBody(t.classB.id, { status: "published" }),
      ),
    );

    const { rows } = await asUser(t.school.id, t.student.userId, (tx) =>
      listAssignments(tx, t.school.id, { limit: 20 }),
    );

    expect(rows).toHaveLength(0);
  });

  test("a student in another school sees nothing", async () => {
    const t = await seedTenant(db.sql);
    const other = await seedTenant(db.sql);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(
        tx,
        t.school.id,
        t.teacherA.userId,
        draftBody(t.classA.id, { status: "published" }),
      ),
    );

    // Scoped to the other tenant in both the GUC and the argument, which is what a compromised or
    // buggy caller would look like.
    const { rows } = await asUser(other.school.id, other.student.userId, (tx) =>
      listAssignments(tx, other.school.id, { limit: 20 }),
    );

    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Filtering and pagination
// ---------------------------------------------------------------------------

describeDb("filtering and pagination", () => {
  test("a cursor walk returns every row exactly once", async () => {
    const t = await seedTenant(db.sql);

    for (let index = 0; index < 5; index += 1) {
      await asUser(t.school.id, t.teacherA.userId, (tx) =>
        createAssignment(
          tx,
          t.school.id,
          t.teacherA.userId,
          draftBody(t.classA.id, { title: `PS ${index}`, due_at: futureIso(index + 1) }),
        ),
      );
    }

    const seen: string[] = [];
    let cursor: string | undefined;

    do {
      const page = await asUser(t.school.id, t.teacherA.userId, (tx) =>
        listAssignments(tx, t.school.id, { limit: 2, cursor }),
      );
      seen.push(...page.rows.map((row) => row.title));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  test("assignments sharing a due date still paginate without loss", async () => {
    // The id tiebreaker in the cursor exists for exactly this: a teacher setting several
    // assignments to the same deadline is ordinary, and a cursor on due_at alone would skip rows.
    const t = await seedTenant(db.sql);
    const sharedDue = futureIso(3);

    for (let index = 0; index < 4; index += 1) {
      await asUser(t.school.id, t.teacherA.userId, (tx) =>
        createAssignment(
          tx,
          t.school.id,
          t.teacherA.userId,
          draftBody(t.classA.id, { title: `Same ${index}`, due_at: sharedDue }),
        ),
      );
    }

    const seen: string[] = [];
    let cursor: string | undefined;

    do {
      const page = await asUser(t.school.id, t.teacherA.userId, (tx) =>
        listAssignments(tx, t.school.id, { limit: 1, cursor }),
      );
      seen.push(...page.rows.map((row) => row.title));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);

    expect(new Set(seen).size).toBe(4);
  });

  test("filters by class and by subject", async () => {
    const t = await seedTenant(db.sql);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(tx, t.school.id, t.teacherA.userId, draftBody(t.classA.id, { title: "A" })),
    );
    await asUser(t.school.id, t.teacherB.userId, (tx) =>
      createAssignment(tx, t.school.id, t.teacherB.userId, draftBody(t.classB.id, { title: "B" })),
    );

    const byClass = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      listAssignments(tx, t.school.id, { limit: 20, class_id: t.classA.id }),
    );
    expect(byClass.rows.map((row) => row.title)).toEqual(["A"]);

    // subject_id is not a column on assignments -- this exercises the classes -> courses join.
    const bySubject = await asUser(t.school.id, t.teacherB.userId, (tx) =>
      listAssignments(tx, t.school.id, { limit: 20, subject_id: t.otherSubject.id }),
    );
    expect(bySubject.rows.map((row) => row.title)).toEqual(["B"]);
  });

  test("filters by upcoming and past_due", async () => {
    const t = await seedTenant(db.sql);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(
        tx,
        t.school.id,
        t.teacherA.userId,
        draftBody(t.classA.id, { title: "Future", due_at: futureIso(5) }),
      ),
    );
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(
        tx,
        t.school.id,
        t.teacherA.userId,
        draftBody(t.classA.id, { title: "Past", due_at: futureIso(-5) }),
      ),
    );

    const upcoming = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      listAssignments(tx, t.school.id, { limit: 20, status: "upcoming" }),
    );
    expect(upcoming.rows.map((row) => row.title)).toEqual(["Future"]);

    const pastDue = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      listAssignments(tx, t.school.id, { limit: 20, status: "past_due" }),
    );
    expect(pastDue.rows.map((row) => row.title)).toEqual(["Past"]);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describeDb("lifecycle", () => {
  test("publishing stamps assigned_at", async () => {
    const t = await seedTenant(db.sql);

    const draft = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(tx, t.school.id, t.teacherA.userId, draftBody(t.classA.id)),
    );
    expect(draft.assigned_at).toBeNull();

    const published = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      updateAssignment(tx, t.school.id, t.teacherA.userId, draft.id, { status: "published" }),
    );

    expect(published.status).toBe("published");
    // Required by ck_assignments_lifecycle -- publishing and stamping the time are one operation.
    expect(published.assigned_at).not.toBeNull();
  });

  test("a published assignment cannot go back to draft", async () => {
    const t = await seedTenant(db.sql);

    const assignment = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(
        tx,
        t.school.id,
        t.teacherA.userId,
        draftBody(t.classA.id, { status: "published" }),
      ),
    );

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        updateAssignment(tx, t.school.id, t.teacherA.userId, assignment.id, { status: "draft" }),
      ),
    ).rejects.toThrow(/cannot return to draft/i);
  });

  test("rejects an update that would invert the date pair against the stored row", async () => {
    // Only decidable against the stored value: the PATCH moves one end of the range, and the
    // schema-level refinement sees only what was sent.
    const t = await seedTenant(db.sql);

    const assignment = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(
        tx,
        t.school.id,
        t.teacherA.userId,
        draftBody(t.classA.id, { available_from: futureIso(2), due_at: futureIso(10) }),
      ),
    );

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        updateAssignment(tx, t.school.id, t.teacherA.userId, assignment.id, {
          due_at: futureIso(1),
        }),
      ),
    ).rejects.toThrow(/available_from/i);
  });

  test("delete removes an assignment with no submissions", async () => {
    const t = await seedTenant(db.sql);

    const assignment = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(tx, t.school.id, t.teacherA.userId, draftBody(t.classA.id)),
    );

    const outcome = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      deleteAssignment(tx, t.school.id, t.teacherA.userId, assignment.id),
    );

    expect(outcome).toBe("deleted");

    const gone = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getAssignment(tx, t.school.id, assignment.id),
    );
    expect(gone).toBeNull();
  });

  test("delete archives instead when submissions exist", async () => {
    // assignment_submissions references assignments ON DELETE RESTRICT, and student work must not
    // be orphaned. Archiving keeps both facts true.
    const t = await seedTenant(db.sql);

    const assignment = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(
        tx,
        t.school.id,
        t.teacherA.userId,
        draftBody(t.classA.id, { status: "published" }),
      ),
    );

    await db.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.school_id', ${t.school.id}, true)`;
      await tx`
        INSERT INTO app.assignment_submissions
          (school_id, assignment_id, student_id, last_edited_by_user_id, status, submitted_at)
        VALUES (
          ${t.school.id}, ${assignment.id}, ${t.student.id}, ${t.student.userId},
          'submitted', CURRENT_TIMESTAMP
        )
      `;
    });

    const outcome = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      deleteAssignment(tx, t.school.id, t.teacherA.userId, assignment.id),
    );

    expect(outcome).toBe("archived");

    const archived = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      getAssignment(tx, t.school.id, assignment.id),
    );
    expect(archived?.status).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describeDb("audit trail", () => {
  async function auditRowsFor(schoolId: string, targetId: string) {
    return db.sql<{ action: string; actor_id: string; old_values: unknown; new_values: unknown }[]>`
      SELECT action, actor_id, old_values, new_values
      FROM app.audit_logs
      WHERE school_id = ${schoolId} AND target_table = 'assignments' AND target_id = ${targetId}
      ORDER BY created_at ASC
    `;
  }

  test("create, update, and delete each write an audit row", async () => {
    const t = await seedTenant(db.sql);

    const assignment = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(tx, t.school.id, t.teacherA.userId, draftBody(t.classA.id)),
    );
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      updateAssignment(tx, t.school.id, t.teacherA.userId, assignment.id, { title: "Renamed" }),
    );
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      deleteAssignment(tx, t.school.id, t.teacherA.userId, assignment.id),
    );

    const rows = await auditRowsFor(t.school.id, assignment.id);

    expect(rows.map((row) => row.action)).toEqual(["insert", "update", "delete"]);
    // actor_id comes from the app.user_id GUC, never from an argument -- see emitAuditLog.
    expect(rows.every((row) => row.actor_id === t.teacherA.userId)).toBe(true);
  });

  test("the update audit row carries a real before/after diff", async () => {
    const t = await seedTenant(db.sql);

    const assignment = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(tx, t.school.id, t.teacherA.userId, draftBody(t.classA.id)),
    );
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      updateAssignment(tx, t.school.id, t.teacherA.userId, assignment.id, { title: "Renamed" }),
    );

    const rows = await auditRowsFor(t.school.id, assignment.id);
    const update = rows.find((row) => row.action === "update");

    expect((update?.old_values as { title: string }).title).toBe("Problem Set 1");
    expect((update?.new_values as { title: string }).title).toBe("Renamed");
  });

  test("a failed mutation leaves no audit row behind", async () => {
    // The audit write shares the mutation's transaction, so the two are atomic in both directions.
    const t = await seedTenant(db.sql);

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        createAssignment(tx, t.school.id, t.teacherA.userId, draftBody(t.classB.id)),
      ),
    ).rejects.toThrow();

    const [{ count }] = await db.sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM app.audit_logs
      WHERE school_id = ${t.school.id} AND target_table = 'assignments'
    `;

    expect(Number(count)).toBe(0);
  });
});
