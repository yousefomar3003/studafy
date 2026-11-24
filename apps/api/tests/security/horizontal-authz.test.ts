/**
 * QA-002: horizontal (object-level) authorization, within a school and across schools.
 *
 * The role matrix (authz-role-matrix.test.ts) proves a role may or may not call a route at all. It
 * cannot see the other half of the question every school-data endpoint has to answer: may *this*
 * caller act on *that* object? Student A vs student B, a parent vs a child who is not theirs, a
 * teacher vs a class they do not teach, a teacher who is also a parent, school A vs school B.
 *
 * Each case below is one actor, one request against one object, and the outcome that must hold:
 *   deny  -- 403 or 404 (both acceptable; 404 is preferred where existence is itself sensitive);
 *   allow -- 2xx, the control that proves the fixture is wired and the deny is not an accident;
 *   excludes -- 2xx, and the listed id appears nowhere in the body.
 *
 * Cases that currently fail because of an open finding are `test.failing` with that QA id: they
 * turn red the moment the bug is fixed, which is the reminder to promote them to plain tests.
 *
 * Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL:
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/security/horizontal-authz.test.ts
 */

// Imported before src/middleware -- see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createDisciplineIncident,
  createMaterial,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";
import { createOtherSchool, createSchoolUnderTest, tokenFor } from "../harness/object-access";

import type { TestApp, TestDatabase } from "../harness";
import type { Actor, OtherSchool, SchoolUnderTest } from "../harness/object-access";

const describeDb = integrationEnabled ? describe : describe.skip;
const OBSERVE = process.env.HORIZONTAL_AUTHZ_OBSERVE === "1";

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let a: SchoolUnderTest;
let b: OtherSchool;
const ids: Record<string, string> = {};

/**
 * deny     -- 403 or 404.
 * allow    -- 2xx.
 * excludes -- 2xx, and ids[key] appears nowhere in the body.
 * hidden   -- deny, or 2xx without ids[key]: the caller learns nothing about the object either way.
 * shows    -- 2xx, and ids[key] is in the body (a control that the seeded object is really there).
 */
type Expectation = "deny" | "allow" | { excludes: string } | { hidden: string } | { shows: string };

interface Case {
  actor: () => { actor: Actor; schoolId: string };
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: () => string;
  body?: () => unknown;
  expect: Expectation;
  /** An open finding this case currently fails on. */
  finding?: string;
  why: string;
}

function inA(pick: (s: SchoolUnderTest) => Actor) {
  return () => ({ actor: pick(a), schoolId: a.schoolId });
}
function inB(pick: (s: OtherSchool) => Actor) {
  return () => ({ actor: pick(b), schoolId: b.schoolId });
}

async function send(c: Case): Promise<{ status: number; text: string }> {
  const { actor, schoolId } = c.actor();
  const token = await tokenFor(harness!.keyStore, schoolId, actor);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const init: RequestInit = { method: c.method, headers };
  if (c.body) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(c.body());
  }
  const response = await harness!.app.request(c.path(), init);
  return { status: response.status, text: await response.text() };
}

function holds(expectation: Expectation, status: number, text: string): boolean {
  const denied = status === 403 || status === 404;
  const ok = status >= 200 && status < 300;
  const contains = (key: string) => {
    const id = ids[key];
    if (!id) throw new Error(`fixture id "${key}" was never seeded`);
    return text.includes(id);
  };
  if (expectation === "deny") return denied;
  if (expectation === "allow") return ok;
  if ("excludes" in expectation) return ok && !contains(expectation.excludes);
  if ("hidden" in expectation) return denied || (ok && !contains(expectation.hidden));
  return ok && contains(expectation.shows);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/** Routes that expose one student's data, keyed by the student's id. */
const STUDENT_SCOPED: {
  path: (studentId: string) => string;
  parentOnly?: boolean;
  /** The seeded id that must not leak; defaults to S2's own id. */
  hiddenKey?: string;
}[] = [
  { path: (s) => `/api/students/${s}` },
  { path: (s) => `/api/students/${s}/records` },
  { path: (s) => `/api/students/${s}/guardians` },
  { path: (s) => `/api/finance/students/${s}` },
  { path: (s) => `/api/finance/students/${s}/installments` },
  { path: (s) => `/api/grading/students/${s}/results` },
  { path: (s) => `/api/grading/students/${s}/certificates` },
  { path: (s) => `/api/grading/students/${s}/marks` },
  { path: (s) => `/api/grading/students/${s}/transcript-readiness` },
  { path: (s) => `/api/grading/students/${s}/transcripts` },
  { path: (s) => `/api/grading/students/${s}/external-exam-results` },
  { path: (s) => `/api/grading/students/${s}/predicted-grades` },
  { path: (s) => `/api/grading/students/${s}/graduation-requirements` },
  { path: (s) => `/api/grading/students/${s}/remedial-plans` },
  { path: (s) => `/api/grades/published/students/${s}/terms/${a?.termId ?? ":termId"}` },
  {
    path: (s) => `/api/attendance/students/${s}/records?start_date=2026-01-01&end_date=2026-12-31`,
    // The response echoes the requested student_id, so the leak to look for is S2's record.
    hiddenKey: "attendanceS2",
  },
  {
    path: (s) => `/api/reports/children/${s}/breakdown?term_id=${a?.termId ?? ":termId"}`,
    parentOnly: true,
  },
  { path: (s) => `/api/reports/children/${s}/timetable`, parentOnly: true },
];

const CASES: (Case & { name: string })[] = [];

// Every student-scoped route, aimed at S2 (class Y), from everyone with no relationship to S2.
for (const route of STUDENT_SCOPED) {
  const deniedActors: [string, () => { actor: Actor; schoolId: string }][] = [
    ["another student (S1)", inA((s) => s.actors.s1)],
    ["a parent of another child (P1)", inA((s) => s.actors.parentP1)],
    ["a teacher who does not teach S2 (teacher A)", inA((s) => s.actors.teacherA)],
    ["another school's ORG_ADMIN", inB((s) => s.actors.orgAdmin)],
  ];
  for (const [who, actor] of deniedActors) {
    CASES.push({
      name: `${who} cannot read ${route.path(":s2")}`,
      actor,
      method: "GET",
      path: () => route.path(a.s2.id),
      expect: { hidden: route.hiddenKey ?? "s2" },
      why: "no relationship to S2",
    });
  }
}

// Controls: the related caller can read S1's data on the routes they are meant to use.
CASES.push(
  {
    name: "the parent can read their own child's report breakdown",
    actor: inA((s) => s.actors.parentP1),
    method: "GET",
    path: () => `/api/reports/children/${a.s1.id}/breakdown?term_id=${a.termId}`,
    expect: "allow",
    why: "control: linked guardian",
  },
  {
    name: "the dual user (teacher B + S1's guardian) can read S1's breakdown as a parent",
    actor: inA((s) => s.actors.dual),
    method: "GET",
    path: () => `/api/reports/children/${a.s1.id}/breakdown?term_id=${a.termId}`,
    expect: "allow",
    why: "control: multi-role user, guardian of S1",
  },
  {
    name: "ORG_ADMIN can read any student in the school",
    actor: inA((s) => s.actors.orgAdmin),
    method: "GET",
    path: () => `/api/students/${a.s2.id}`,
    expect: "allow",
    why: "control: school-wide staff",
  },
  {
    name: "teacher B can read S2's attendance records (teaches class Y)",
    actor: inA((s) => s.actors.teacherB),
    method: "GET",
    path: () =>
      `/api/attendance/students/${a.s2.id}/records?start_date=2026-01-01&end_date=2026-12-31`,
    expect: { shows: "attendanceS2" },
    why: "control: lead teacher of the student's class",
  },
);

// Class-scoped: enrollment lists are for staff holding enrollment:read (QA-086).
CASES.push(
  {
    name: "S1 listing class Y's enrollments does not see S2",
    actor: inA((s) => s.actors.s1),
    method: "GET",
    path: () => `/api/academics/classes/${a.classY}/enrollments`,
    expect: "deny",
    why: "QA-086: enrollment lists need enrollment:read, which students do not hold",
  },
  {
    name: "P1 listing class Y's enrollments does not see S2",
    actor: inA((s) => s.actors.parentP1),
    method: "GET",
    path: () => `/api/academics/classes/${a.classY}/enrollments`,
    expect: "deny",
    why: "QA-086: enrollment lists need enrollment:read, which parents do not hold",
  },
  {
    name: "another school's ORG_ADMIN cannot read class X",
    actor: inB((s) => s.actors.orgAdmin),
    method: "GET",
    path: () => `/api/academics/classes/${a.classX}`,
    expect: "deny",
    why: "tenant isolation",
  },
  {
    name: "S2 cannot read S1's class overview in class X",
    actor: inA((s) => s.actors.s2),
    method: "GET",
    path: () => `/api/academics/classes/${a.classX}/students/${a.s1.id}/overview`,
    expect: "deny",
    why: "another student",
  },
);

// Materials in class X (uploaded by teacher A).
CASES.push(
  {
    name: "S2 (class Y) cannot read class X's material",
    actor: inA((s) => s.actors.s2),
    method: "GET",
    path: () => `/api/academics/materials/${ids.materialX}`,
    expect: "deny",
    why: "not enrolled in class X",
  },
  {
    name: "teacher A cannot edit class Y's material",
    actor: inA((s) => s.actors.teacherA),
    method: "PATCH",
    path: () => `/api/academics/materials/${ids.materialY}`,
    body: () => ({ title: "defaced by teacher A" }),
    expect: "deny",
    why: "does not teach class Y and has no other link to it",
  },
  {
    name: "teacher B (signed in as INSTRUCTOR only) cannot edit class X's material",
    actor: inA((s) => s.actors.teacherB),
    method: "PATCH",
    path: () => `/api/academics/materials/${ids.materialX}`,
    body: () => ({ title: "defaced by teacher B" }),
    expect: "deny",
    why: "does not teach class X; RLS still admits it because the same user is S1's guardian",
  },
  {
    name: "another school's ORG_ADMIN cannot delete class X's material",
    actor: inB((s) => s.actors.orgAdmin),
    method: "DELETE",
    path: () => `/api/academics/materials/${ids.materialX}`,
    expect: "deny",
    why: "tenant isolation",
  },
  {
    name: "S1 (enrolled in class X) cannot edit the teacher's material",
    actor: inA((s) => s.actors.s1),
    method: "PATCH",
    path: () => `/api/academics/materials/${ids.materialX}`,
    body: () => ({ title: "defaced by a student" }),
    expect: "deny",
    why: "students read materials; only the class's teachers may change them",
  },
  {
    name: "P1 (S1's parent) cannot make class X's material visible to the AI provider",
    actor: inA((s) => s.actors.parentP1),
    method: "PATCH",
    path: () => `/api/academics/materials/${ids.materialX}/ai-visible`,
    body: () => ({ ai_visible: true }),
    expect: "deny",
    why: "material:manageAi is a teacher/admin decision",
  },
  {
    name: "the dual user (teaches Y, parent in X) cannot edit class X's material",
    actor: inA((s) => s.actors.dual),
    method: "PATCH",
    path: () => `/api/academics/materials/${ids.materialX}`,
    body: () => ({ title: "defaced via the parent link" }),
    expect: "deny",
    why: "a parent link must not grant teacher-level writes",
  },
);

// Material controls and further denials (QA-008): the class's own teacher and school leadership
// keep full write access; nobody else in the class does.
CASES.push(
  {
    name: "teacher A (teaches class X) can edit class X's material",
    actor: inA((s) => s.actors.teacherA),
    method: "PATCH",
    path: () => `/api/academics/materials/${ids.materialX}`,
    body: () => ({ title: "Teacher A's worksheet, revised" }),
    expect: "allow",
    why: "control: lead teacher of the class",
  },
  {
    name: "ORG_ADMIN can edit class X's material",
    actor: inA((s) => s.actors.orgAdmin),
    method: "PATCH",
    path: () => `/api/academics/materials/${ids.materialX}`,
    body: () => ({ title: "Teacher A's worksheet, revised by admin" }),
    expect: "allow",
    why: "control: school leadership",
  },
  {
    name: "S1 cannot delete class X's material",
    actor: inA((s) => s.actors.s1),
    method: "DELETE",
    path: () => `/api/academics/materials/${ids.materialY}`,
    expect: "deny",
    why: "students never delete materials",
  },
  {
    name: "S1 cannot start a material upload into class X",
    actor: inA((s) => s.actors.s1),
    method: "POST",
    path: () => "/api/academics/materials/upload",
    body: () => ({
      class_id: a.classX,
      title: "Planted by a student",
      file_name: "planted.pdf",
      mime_type: "application/pdf",
      size_bytes: 1024,
    }),
    expect: "deny",
    why: "material:create is a teacher permission",
  },
);

// Discipline incident about S2 (class Y), reported by teacher B.
CASES.push(
  {
    name: "teacher A (does not teach S2) cannot read S2's discipline incident",
    actor: inA((s) => s.actors.teacherA),
    method: "GET",
    path: () => `/api/discipline/incidents/${ids.incidentS2}`,
    expect: "deny",
    why: "discipline records of untaught minors are leadership-only",
  },
  {
    name: "teacher A's incident list does not contain S2's incident",
    actor: inA((s) => s.actors.teacherA),
    method: "GET",
    path: () => `/api/discipline/incidents?limit=100`,
    expect: { excludes: "incidentS2" },
    why: "same scope for the list as for a single read",
  },
  {
    name: "P1 cannot read S2's discipline incident",
    actor: inA((s) => s.actors.parentP1),
    method: "GET",
    path: () => `/api/discipline/incidents/${ids.incidentS2}`,
    expect: "deny",
    why: "not their child",
  },
  {
    name: "S1 cannot read S2's discipline incident",
    actor: inA((s) => s.actors.s1),
    method: "GET",
    path: () => `/api/discipline/incidents/${ids.incidentS2}`,
    expect: "deny",
    why: "another student",
  },
  {
    name: "another school's ORG_ADMIN cannot read S2's discipline incident",
    actor: inB((s) => s.actors.orgAdmin),
    method: "GET",
    path: () => `/api/discipline/incidents/${ids.incidentS2}`,
    expect: "deny",
    why: "tenant isolation",
  },
  {
    name: "teacher B (teaches S2) can read S2's discipline incident",
    actor: inA((s) => s.actors.teacherB),
    method: "GET",
    path: () => `/api/discipline/incidents/${ids.incidentS2}`,
    expect: "allow",
    why: "control: lead teacher of the student's class",
  },
);

// Audit log: FINANCE has no grade permission, so grade values must not reach it via the log.
CASES.push(
  {
    name: "FINANCE's audit-log view does not expose grade values",
    actor: inA((s) => s.actors.finance),
    method: "GET",
    path: () => `/api/audit/logs?limit=100`,
    expect: { excludes: "gradeAuditMarker" },
    why: "FINANCE holds no GRADE_READ",
  },
  {
    name: "another school's ORG_ADMIN does not see school A's audit rows",
    actor: inB((s) => s.actors.orgAdmin),
    method: "GET",
    path: () => `/api/audit/logs?limit=100`,
    expect: { excludes: "gradeAuditMarker" },
    why: "tenant isolation",
  },
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(database.url);
  const sql = database.sql;
  a = await createSchoolUnderTest(sql);
  b = await createOtherSchool(sql);
  ids.s2 = a.s2.id;

  ids.materialX = (
    await createMaterial(sql, a.schoolId, {
      classId: a.classX,
      uploadedByUserId: a.actors.teacherA.userId,
      title: "Teacher A's worksheet",
    })
  ).id;
  ids.materialY = (
    await createMaterial(sql, a.schoolId, {
      classId: a.classY,
      uploadedByUserId: a.actors.teacherB.userId,
      title: "Teacher B's worksheet",
    })
  ).id;
  ids.incidentS2 = (
    await createDisciplineIncident(sql, a.schoolId, {
      studentId: a.s2.id,
      reporterUserId: a.actors.teacherB.userId,
      classId: a.classY,
    })
  ).id;

  // S2 was absent from class Y on 15 September: a real record the attendance routes either show
  // (to S2's teacher) or must hide.
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${a.schoolId}, true)`;
    const [session] = await tx<{ id: string; created_at: Date }[]>`
      INSERT INTO app.attendance_sessions (school_id, class_id, session_date, period, status, taken_by_user_id)
      VALUES (${a.schoolId}, ${a.classY}, '2026-09-15'::date, 1, 'submitted'::app.attendance_session_status,
              ${a.actors.teacherB.userId})
      RETURNING id, created_at
    `;
    const [record] = await tx<{ id: string }[]>`
      INSERT INTO app.attendance_records
        (school_id, attendance_session_id, session_created_at, student_id, status, recorded_by_user_id)
      VALUES (${a.schoolId}, ${session!.id}, ${session!.created_at}, ${a.s2.id},
              'absent'::app.attendance_status, ${a.actors.teacherB.userId})
      RETURNING id
    `;
    ids.attendanceS2 = record!.id;
  });

  // A grade change as the grade-entry service audits it (grade-entry-service.ts): the score itself
  // travels in new_values. The marker is what must not reach FINANCE.
  ids.gradeAuditMarker = `grade-marker-${crypto.randomUUID()}`;
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${a.schoolId}, true)`;
    await tx`
      INSERT INTO app.audit_logs
        (school_id, actor_id, action, target_table, target_id, old_values, new_values)
      VALUES (${a.schoolId}::uuid, ${a.actors.teacherA.userId}::uuid, 'update', 'grades',
              ${crypto.randomUUID()}::uuid, ${sql.json({ score: 12 })},
              ${sql.json({ score: 17, note: ids.gradeAuditMarker })})
    `;
  });

  const created = createTestApp({ database: sql });
  await created.ready;
  harness = created;
}, 120_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

describeDb("horizontal authorization (QA-002)", () => {
  test("covers at least 60 object-level cases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
  });

  for (const c of CASES) {
    const label = `${c.name} [${c.method} ${c.why}]`;
    const body = async () => {
      const { status, text } = await send(c);
      if (OBSERVE) {
        const ok = holds(c.expect, status, text);
        console.log(`OBSERVE ${ok ? "ok  " : "FAIL"} ${status} ${c.finding ?? "-"} ${c.name}`);
        if (!ok && status === 200) console.log(`  body: ${text.slice(0, 300)}`);
      }
      expect({ status, holds: holds(c.expect, status, text) }).toEqual({ status, holds: true });
    };
    if (c.finding && !OBSERVE) {
      test.failing(`${label} — open finding ${c.finding}`, body);
    } else {
      test(label, body);
    }
  }
});
