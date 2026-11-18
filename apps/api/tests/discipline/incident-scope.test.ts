/**
 * QA-039: discipline incidents are visible to the people responsible for the student, not to every
 * teacher in the school.
 *
 * The incident routes gated only on DISCIPLINE_INCIDENT_READ, which every INSTRUCTOR holds, and the
 * queries filtered by school alone, so `GET /api/discipline/incidents` as any teacher returned the
 * title, description and severity of incidents about minors they do not teach. Reads are now scoped
 * to leadership, the student's own teachers, and the incident's reporter; and an incident can only
 * be filed against a student enrolled in the class it names.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/discipline/incident-scope.test.ts
 */

// Imported before src/middleware -- see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestApp, createTestDatabase, integrationEnabled, migrateDatabase } from "../harness";
import { createSchoolUnderTest, tokenFor } from "../harness/object-access";

import type { TestApp, TestDatabase } from "../harness";
import type { Actor, SchoolUnderTest } from "../harness/object-access";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let a: SchoolUnderTest;
let incidentAboutS2: string;

async function call(actor: Actor, method: string, path: string, body?: unknown) {
  const token = await tokenFor(harness!.keyStore, a.schoolId, actor);
  const response = await harness!.app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const incident = (studentId: string, classId: string) => ({
  student_id: studentId,
  class_id: classId,
  incident_type: "behavioral",
  severity: "moderate",
  title: "Disruption in class",
  description: "Sensitive details about a minor",
  incident_at: "2026-11-10T09:00:00.000Z",
});

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  a = await createSchoolUnderTest(database.sql);
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
  // Filed by the principal about s2, who is only in class Y (teacher B's).
  const filed = await call(
    a.actors.principal,
    "POST",
    "/api/discipline/incidents",
    incident(a.s2.id, a.classY),
  );
  expect(filed.status).toBe(201);
  incidentAboutS2 = filed.body.id as string;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

describeDb("discipline incident scope (QA-039)", () => {
  test("teacher A (class X) does not see an incident about a student only in class Y", async () => {
    const list = await call(a.actors.teacherA, "GET", "/api/discipline/incidents?limit=100");
    expect(list.status).toBe(200);
    const ids = (list.body.incidents as { id: string }[]).map((row) => row.id);
    expect(ids).not.toContain(incidentAboutS2);
    const one = await call(
      a.actors.teacherA,
      "GET",
      `/api/discipline/incidents/${incidentAboutS2}`,
    );
    expect(one.status).toBe(404);
    const actions = await call(
      a.actors.teacherA,
      "GET",
      `/api/discipline/incidents/${incidentAboutS2}/actions`,
    );
    // 403 (no DISCIPLINE_ACTION_READ) or 404 (out of scope): either way, nothing is disclosed.
    expect([403, 404]).toContain(actions.status);
  });

  test("teacher B (the student's teacher) and leadership do see it", async () => {
    const asTeacherB = await call(
      a.actors.teacherB,
      "GET",
      `/api/discipline/incidents/${incidentAboutS2}`,
    );
    expect(asTeacherB.status).toBe(200);
    const asAdmin = await call(
      a.actors.orgAdmin,
      "GET",
      `/api/discipline/incidents/${incidentAboutS2}`,
    );
    expect(asAdmin.status).toBe(200);
  });

  test("a mismatched student and class on create is refused", async () => {
    // s2 is not enrolled in class X.
    const res = await call(
      a.actors.principal,
      "POST",
      "/api/discipline/incidents",
      incident(a.s2.id, a.classX),
    );
    expect(res.status).toBe(400);
  });
});
