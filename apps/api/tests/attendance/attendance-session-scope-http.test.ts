/**
 * QA-087: opening, cancelling and locking an attendance session requires teaching the class.
 *
 * Session open and status changes relied only on the class being in the caller's readable set,
 * which includes a parent's view of their child's class. A user who is both a teacher (so holds the
 * attendance permission) and a parent could open, cancel or lock sessions for their child's class.
 * Writes now check `teaches_class OR attendance officer OR school admin` explicitly, as recording
 * attendance already did.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/attendance/attendance-session-scope-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createTeacher,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestApp, TestDatabase, TenantFixture } from "../harness";
import type { Role } from "@studafy/constants";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;
let teacher: Actor;
let teacherParent: Actor;

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const sql = database.sql;
  tenant = await createFullTenant(sql);
  const schoolId = tenant.schoolId;

  const classTeacher = tenant.teachers[0]!;
  await assignRole(sql, schoolId, classTeacher.userId, ROLES.INSTRUCTOR);
  teacher = { schoolId, userId: classTeacher.userId, roles: [ROLES.INSTRUCTOR] };

  // Teaches elsewhere in the school, and is the parent of a student in the class.
  const user = { id: (await createTeacher(sql, schoolId)).userId };
  await assignRole(sql, schoolId, user.id, ROLES.INSTRUCTOR);
  await assignRole(sql, schoolId, user.id, ROLES.PARENT);
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}::uuid, 'Family', ${user.id}::uuid) RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${schoolId}::uuid, ${family!.id}::uuid, ${user.id}::uuid,
              ${tenant.students[0]!.id}::uuid, 'father')
    `;
  });
  teacherParent = { schoolId, userId: user.id, roles: [ROLES.INSTRUCTOR, ROLES.PARENT] };

  const created = createTestApp({ database: sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

function request(actor: Actor, method: string, path: string, body?: unknown) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    { channel: "web", ...actor },
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

const TODAY = new Date().toISOString().slice(0, 10);

describeDb("attendance session writes need the class (QA-087)", () => {
  test("a teacher who is a parent in the class cannot open its session", async () => {
    const res = await request(teacherParent, "POST", "/api/attendance/sessions", {
      class_id: tenant.cls.id,
      session_date: TODAY,
    });
    expect(res.status).toBe(403);
  });

  test("nor cancel the class teacher's session", async () => {
    const opened = await request(teacher, "POST", "/api/attendance/sessions", {
      class_id: tenant.cls.id,
      session_date: TODAY,
    });
    expect([200, 201]).toContain(opened.status);
    const { id } = (await opened.json()) as { id: string };

    const cancel = await request(teacherParent, "PATCH", `/api/attendance/sessions/${id}`, {
      status: "cancelled",
    });
    expect(cancel.status).toBe(403);

    // The class teacher still can.
    const own = await request(teacher, "PATCH", `/api/attendance/sessions/${id}`, {
      status: "cancelled",
    });
    expect(own.status).toBe(200);
  });
});
