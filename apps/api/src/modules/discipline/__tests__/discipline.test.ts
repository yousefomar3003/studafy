// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  createTestDatabase,
  migrateDatabase,
  createSchool,
  createStudent,
  createTeacher,
  createDisciplineIncident,
  createDisciplineAction,
  integrationEnabled,
  type TestDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import {
  createIncident,
  getIncident,
  listIncidents,
  updateIncident,
  resolveIncident,
  listActions,
  createAction,
  updateAction,
  getParentResolvedIncidents,
  getParentDisciplineVisibility,
} from "../discipline-service";

import type { TenantContext } from "../../../db/tenant-tx";
import type { TransactionSql } from "postgres";

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

/**
 * Run `fn` in the same tenant transaction a route opens (`withTenantTx`): role studafy_app with
 * `app.school_id` and, when given, `app.user_id` armed. The discipline tables are guarded by
 * tenant_isolation; the acting user is the reporting teacher wherever a test has one, so audit rows
 * carry the same actor_id a route would write.
 */
function withTx<T>(tenant: TenantContext, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return withTenantTx(db.sql, tenant, fn);
}

describeDb("createIncident", () => {
  test("creates and returns a new incident", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student = await createStudent(db.sql, school.id);

    const incident = await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      createIncident(tx, school.id, teacher.userId, {
        student_id: student.id,
        incident_type: "behavioral",
        severity: "minor",
        title: "Disruptive behavior in class",
        description: "Student was talking during lecture",
        incident_at: new Date().toISOString(),
      }),
    );

    expect(incident).toBeDefined();
    expect(incident.title).toBe("Disruptive behavior in class");
    expect(incident.status).toBe("reported");
    expect(incident.severity).toBe("minor");
    expect(incident.student_id).toBe(student.id);
    expect(incident.reporter_user_id).toBe(teacher.userId);
  });

  test("rejects empty title via database constraint", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student = await createStudent(db.sql, school.id);

    await expect(
      withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
        createIncident(tx, school.id, teacher.userId, {
          student_id: student.id,
          incident_type: "other",
          severity: "moderate",
          title: "",
          incident_at: new Date().toISOString(),
        }),
      ),
    ).rejects.toThrow();
  });
});

describeDb("listIncidents", () => {
  test("returns paginated results", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student = await createStudent(db.sql, school.id);

    await createDisciplineIncident(db.sql, school.id, {
      studentId: student.id,
      reporterUserId: teacher.userId,
      title: "Incident A",
    });
    await createDisciplineIncident(db.sql, school.id, {
      studentId: student.id,
      reporterUserId: teacher.userId,
      title: "Incident B",
    });

    const { rows, total } = await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      listIncidents(tx, school.id, { limit: 10, offset: 0 }),
    );

    expect(total).toBe(2);
    expect(rows).toHaveLength(2);
  });

  test("filters by student_id", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student1 = await createStudent(db.sql, school.id, { email: "s1@test.local" });
    const student2 = await createStudent(db.sql, school.id, { email: "s2@test.local" });

    await createDisciplineIncident(db.sql, school.id, {
      studentId: student1.id,
      reporterUserId: teacher.userId,
    });
    await createDisciplineIncident(db.sql, school.id, {
      studentId: student2.id,
      reporterUserId: teacher.userId,
    });

    const { rows, total } = await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      listIncidents(tx, school.id, { limit: 10, offset: 0, student_id: student1.id }),
    );

    expect(total).toBe(1);
    expect(rows[0]?.student_id).toBe(student1.id);
  });
});

describeDb("getIncident", () => {
  test("returns incident by id", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student = await createStudent(db.sql, school.id);

    const created = await createDisciplineIncident(db.sql, school.id, {
      studentId: student.id,
      reporterUserId: teacher.userId,
    });

    const incident = await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      getIncident(tx, school.id, created.id),
    );

    expect(incident).toBeDefined();
    expect(incident!.id).toBe(created.id);
  });

  test("returns undefined for non-existent incident", async () => {
    const school = await createSchool(db.sql);
    const incident = await withTx({ schoolId: school.id }, (tx) =>
      getIncident(tx, school.id, "00000000-0000-0000-0000-000000000000"),
    );

    expect(incident).toBeUndefined();
  });
});

describeDb("updateIncident", () => {
  test("updates severity", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student = await createStudent(db.sql, school.id);

    const created = await createDisciplineIncident(db.sql, school.id, {
      studentId: student.id,
      reporterUserId: teacher.userId,
      severity: "minor",
    });

    const updated = await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      updateIncident(tx, school.id, created.id, { severity: "major" }),
    );

    expect(updated.severity).toBe("major");
  });

  test("enforces valid status transitions", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student = await createStudent(db.sql, school.id);

    const created = await createDisciplineIncident(db.sql, school.id, {
      studentId: student.id,
      reporterUserId: teacher.userId,
    });

    await expect(
      withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
        updateIncident(tx, school.id, created.id, { status: "resolved" }),
      ),
    ).resolves.toBeDefined();

    await expect(
      withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
        updateIncident(tx, school.id, created.id, { status: "reported" }),
      ),
    ).rejects.toThrow("Cannot transition");
  });
});

describeDb("resolveIncident", () => {
  test("resolves a reported incident", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student = await createStudent(db.sql, school.id);

    const created = await createDisciplineIncident(db.sql, school.id, {
      studentId: student.id,
      reporterUserId: teacher.userId,
    });

    const resolved = await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      resolveIncident(tx, school.id, created.id),
    );

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolved_at).not.toBeNull();
  });

  test("rejects resolve on already resolved incident", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student = await createStudent(db.sql, school.id);

    const created = await createDisciplineIncident(db.sql, school.id, {
      studentId: student.id,
      reporterUserId: teacher.userId,
    });

    await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      resolveIncident(tx, school.id, created.id),
    );

    const closed = await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      updateIncident(tx, school.id, created.id, { status: "closed" }),
    );

    expect(closed.status).toBe("closed");
  });
});

describeDb("createAction", () => {
  test("creates action on a reported incident", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student = await createStudent(db.sql, school.id);

    const incident = await createDisciplineIncident(db.sql, school.id, {
      studentId: student.id,
      reporterUserId: teacher.userId,
    });

    const action = await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      createAction(tx, school.id, teacher.userId, incident.id, {
        action_type: "detention",
        description: "After-school detention",
      }),
    );

    expect(action).toBeDefined();
    expect(action.action_type).toBe("detention");
    expect(action.incident_id).toBe(incident.id);
  });

  test("rejects action on closed incident", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student = await createStudent(db.sql, school.id);

    const incident = await createDisciplineIncident(db.sql, school.id, {
      studentId: student.id,
      reporterUserId: teacher.userId,
    });

    await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      resolveIncident(tx, school.id, incident.id),
    );
    await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      updateIncident(tx, school.id, incident.id, { status: "closed" }),
    );

    await expect(
      withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
        createAction(tx, school.id, teacher.userId, incident.id, {
          action_type: "detention",
        }),
      ),
    ).rejects.toThrow();
  });
});

describeDb("updateAction", () => {
  test("transitions action status", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student = await createStudent(db.sql, school.id);

    const incident = await createDisciplineIncident(db.sql, school.id, {
      studentId: student.id,
      reporterUserId: teacher.userId,
    });

    const action = await createDisciplineAction(db.sql, school.id, {
      incidentId: incident.id,
      actionByUserId: teacher.userId,
      actionType: "detention",
    });

    const updated = await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      updateAction(tx, school.id, incident.id, action.id, { status: "active" }),
    );

    expect(updated.status).toBe("active");
  });

  test("rejects invalid action transition", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student = await createStudent(db.sql, school.id);

    const incident = await createDisciplineIncident(db.sql, school.id, {
      studentId: student.id,
      reporterUserId: teacher.userId,
    });

    const action = await createDisciplineAction(db.sql, school.id, {
      incidentId: incident.id,
      actionByUserId: teacher.userId,
    });

    await expect(
      withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
        updateAction(tx, school.id, incident.id, action.id, {
          status: "completed",
        }),
      ),
    ).rejects.toThrow(); // pending -> completed is invalid
  });
});

describeDb("getParentResolvedIncidents", () => {
  test("returns only resolved incidents for given students", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student = await createStudent(db.sql, school.id);

    const incident1 = await createDisciplineIncident(db.sql, school.id, {
      studentId: student.id,
      reporterUserId: teacher.userId,
      title: "Resolved incident",
    });

    await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      resolveIncident(tx, school.id, incident1.id),
    );

    await createDisciplineIncident(db.sql, school.id, {
      studentId: student.id,
      reporterUserId: teacher.userId,
      title: "Unresolved incident",
    });

    const { rows, total } = await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      getParentResolvedIncidents(tx, school.id, [student.id], { limit: 10, offset: 0 }),
    );

    expect(total).toBe(1);
    expect(rows[0]?.title).toBe("Resolved incident");
  });

  test("returns empty for no children", async () => {
    const school = await createSchool(db.sql);

    const { rows, total } = await withTx({ schoolId: school.id }, (tx) =>
      getParentResolvedIncidents(tx, school.id, [], { limit: 10, offset: 0 }),
    );

    expect(total).toBe(0);
    expect(rows).toHaveLength(0);
  });
});

describeDb("getParentDisciplineVisibility", () => {
  test("returns false by default", async () => {
    const school = await createSchool(db.sql);

    const visible = await withTx({ schoolId: school.id }, (tx) =>
      getParentDisciplineVisibility(tx, school.id),
    );

    expect(visible).toBe(false);
  });
});

describeDb("listActions", () => {
  test("returns actions for an incident", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const student = await createStudent(db.sql, school.id);

    const incident = await createDisciplineIncident(db.sql, school.id, {
      studentId: student.id,
      reporterUserId: teacher.userId,
    });

    await createDisciplineAction(db.sql, school.id, {
      incidentId: incident.id,
      actionByUserId: teacher.userId,
      actionType: "verbal_warning",
    });

    const { rows, total } = await withTx({ schoolId: school.id, userId: teacher.userId }, (tx) =>
      listActions(tx, school.id, incident.id, { limit: 10, offset: 0 }),
    );

    expect(total).toBe(1);
    expect(rows[0]?.action_type).toBe("verbal_warning");
  });
});
