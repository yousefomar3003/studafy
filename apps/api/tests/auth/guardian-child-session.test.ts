import { OpenAPIHono } from "@hono/zod-openapi";
import { ROLES } from "@studafy/constants";
import { afterAll, beforeAll, describe, expect, test } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { KeyStore } from "../../src/modules/auth";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import { guardianSessionRoutes } from "../../src/modules/auth/routes/guardian-session-routes";
import {
  assignRole,
  createSchool,
  createStudent,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  mintTestToken,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
} from "../harness";

import type { AppEnv } from "../../src/middleware";
import type { TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";
import type { Sql } from "postgres";

/**
 * "Add <child> to this phone" (000217): a parent opens their linked child's own session from the
 * parent app. Only a parent, only for a linked child, only while the school allows it and the
 * child's account is in use; the session is the child's, marked as opened by the parent in the
 * child's session list, and the parent is the audit actor.
 */

const integrationTest = test.skipIf(!integrationEnabled);
const sessionPath = (studentId: string) => `/api/auth/guardian/children/${studentId}/session`;

let database: TestDatabase | undefined;
let sql: Sql;
let keyStore: KeyStore;
let app: OpenAPIHono<AppEnv>;
let schoolId: string;
let adminId: string;

interface Child {
  studentId: string;
  userId: string;
}

async function asAdmin<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

async function newUser(roles: Role[]): Promise<string> {
  const user = await createUser(sql, schoolId);
  for (const role of roles) await assignRole(sql, schoolId, user.id, role);
  return user.id;
}

async function newChild(firstName = "Sara"): Promise<Child> {
  const student = await createStudent(sql, schoolId, { firstName, lastName: "Haddad" });
  await assignRole(sql, schoolId, student.userId, ROLES.STUDENT);
  return { studentId: student.id, userId: student.userId };
}

async function link(parentId: string, child: Child): Promise<void> {
  await asAdmin(async (tx) => {
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}::uuid, 'Family', ${parentId}::uuid)
      RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${schoolId}::uuid, ${family!.id}::uuid, ${parentId}::uuid, ${child.studentId}::uuid, 'mother')
    `;
  });
}

function tokenFor(userId: string, roles: Role[]): Promise<string> {
  return mintTestToken(keyStore, { schoolId, userId, roles, channel: AUTH_CHANNELS.MOBILE });
}

async function open(studentId: string, token: string): Promise<Response> {
  return app.request(sessionPath(studentId), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(((await response.json()) as { code: string }).code).toBe(code);
}

async function setSchoolAllows(allowed: boolean): Promise<void> {
  const token = await mintTestToken(keyStore, {
    schoolId,
    userId: adminId,
    roles: [ROLES.ORG_ADMIN],
    channel: AUTH_CHANNELS.WEB,
  });
  const response = await app.request("/api/schools/current/settings", {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ allow_parent_device_signin: allowed }),
  });
  expect(response.status).toBe(200);
  expect(
    ((await response.json()) as { allow_parent_device_signin: boolean }).allow_parent_device_signin,
  ).toBe(allowed);
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;
  const school = await createSchool(sql, { name: "Family Phone Academy" });
  schoolId = school.id;
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`UPDATE app.schools SET status = 'active'::app.school_status WHERE id = ${schoolId}`;
  });
  adminId = await newUser([ROLES.ORG_ADMIN]);

  keyStore = new KeyStore(60_000);
  await keyStore.init();
  resetSecurityConfig();
  app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({
      destination: process.env.DEBUG_TEST
        ? (line: string) => process.stderr.write(line)
        : () => undefined,
    }),
    database: sql,
    keyStore,
    jwtIssuer: TEST_JWT_ISSUER,
    jwtAudience: TEST_JWT_AUDIENCE,
  });
}, 60_000);

afterAll(async () => {
  keyStore?.destroy();
  await database?.cleanup();
});

describe("POST /api/auth/guardian/children/{studentId}/session", () => {
  integrationTest(
    "a linked parent gets the child's own session, marked as theirs and audited",
    async () => {
      const parentId = await newUser([ROLES.PARENT]);
      const child = await newChild();
      await link(parentId, child);

      const response = await open(child.studentId, await tokenFor(parentId, [ROLES.PARENT]));
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        access_token: string;
        refresh_token: string;
        session_id: string;
        token_type: string;
        child: { user_id: string; display_name: string; school_name: string; member_ids: string[] };
      };
      expect(body.token_type).toBe("Bearer");
      expect(body.refresh_token.length).toBeGreaterThan(20);
      expect(body.child.user_id).toBe(child.userId);
      expect(body.child.display_name).toBe("Sara Haddad");
      expect(body.child.school_name).toBe("Family Phone Academy");
      expect(body.child.member_ids.every((code) => code.startsWith("STU-"))).toBe(true);

      // The access token is the child's: their session list shows it, opened by the parent.
      const sessions = await app.request("/api/auth/sessions", {
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      expect(sessions.status).toBe(200);
      const list = (await sessions.json()) as {
        sessions: { id: string; opened_by_guardian_user_id: string | null }[];
      };
      expect(list.sessions).toHaveLength(1);
      expect(list.sessions[0]!.id).toBe(body.session_id);
      expect(list.sessions[0]!.opened_by_guardian_user_id).toBe(parentId);

      // It renews like any session and stays marked after rotation (keyed by family).
      const refreshed = await app.request("/api/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: body.refresh_token }),
      });
      expect(refreshed.status).toBe(200);
      const renewed = (await refreshed.json()) as { access_token: string };
      const after = (await (
        await app.request("/api/auth/sessions", {
          headers: { authorization: `Bearer ${renewed.access_token}` },
        })
      ).json()) as { sessions: { opened_by_guardian_user_id: string | null }[] };
      expect(after.sessions[0]!.opened_by_guardian_user_id).toBe(parentId);

      // An administrator sees the marker too.
      const adminToken = await mintTestToken(keyStore, {
        schoolId,
        userId: adminId,
        roles: [ROLES.ORG_ADMIN],
        channel: AUTH_CHANNELS.WEB,
      });
      const adminList = await app.request(`/api/admin/users/${child.userId}/sessions`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(adminList.status).toBe(200);
      const adminBody = (await adminList.json()) as {
        sessions: { opened_by_guardian_user_id: string | null }[];
      };
      expect(adminBody.sessions[0]!.opened_by_guardian_user_id).toBe(parentId);

      // The parent is the audit actor; the target is the new session.
      const [audit] = await asAdmin(
        (tx) => tx<{ actor_id: string; target_id: string; outcome: string }[]>`
          SELECT actor_id::text, target_id::text, new_values->>'outcome' AS outcome
          FROM app.audit_logs
          WHERE target_table = 'refresh_tokens' AND new_values->>'method' = 'guardian_device'
            AND new_values->>'student_user_id' = ${child.userId}
        `,
      );
      expect(audit).toBeDefined();
      expect(audit!.actor_id).toBe(parentId);
      expect(audit!.target_id).toBe(body.session_id);
      expect(audit!.outcome).toBe("GUARDIAN_SESSION_ISSUED");
    },
  );

  integrationTest("anyone who is not a parent is refused", async () => {
    const child = await newChild();
    for (const roles of [[ROLES.INSTRUCTOR], [ROLES.STUDENT], [ROLES.ORG_ADMIN]] as Role[][]) {
      const userId = await newUser(roles);
      await expectCode(
        await open(child.studentId, await tokenFor(userId, roles)),
        403,
        "AUTHZ_FORBIDDEN",
      );
    }
  });

  integrationTest(
    "a parent can't open someone else's child, or a student that doesn't exist",
    async () => {
      const parentId = await newUser([ROLES.PARENT]);
      await link(parentId, await newChild());
      const otherChild = await newChild("Omar");
      await link(await newUser([ROLES.PARENT]), otherChild);
      const token = await tokenFor(parentId, [ROLES.PARENT]);

      await expectCode(await open(otherChild.studentId, token), 404, "RESOURCE_NOT_FOUND");
      await expectCode(await open(crypto.randomUUID(), token), 404, "RESOURCE_NOT_FOUND");
    },
  );

  integrationTest("the school can turn it off", async () => {
    const parentId = await newUser([ROLES.PARENT]);
    const child = await newChild();
    await link(parentId, child);
    const token = await tokenFor(parentId, [ROLES.PARENT]);

    await setSchoolAllows(false);
    try {
      await expectCode(await open(child.studentId, token), 403, "AUTHZ_FORBIDDEN");
    } finally {
      await setSchoolAllows(true);
    }
    expect((await open(child.studentId, token)).status).toBe(200);
  });

  integrationTest("a locked child account is refused", async () => {
    const parentId = await newUser([ROLES.PARENT]);
    const child = await newChild();
    await link(parentId, child);
    await asAdmin(
      (tx) => tx`
        INSERT INTO app.member_credentials (school_id, user_id, failed_attempts, locked_until)
        VALUES (${schoolId}::uuid, ${child.userId}::uuid, 5, CURRENT_TIMESTAMP + interval '15 minutes')
        ON CONFLICT (school_id, user_id) DO UPDATE
          SET failed_attempts = 5, locked_until = EXCLUDED.locked_until
      `,
    );

    await expectCode(
      await open(child.studentId, await tokenFor(parentId, [ROLES.PARENT])),
      403,
      "AUTH_ACCOUNT_LOCKED",
    );
  });

  integrationTest("a child who has left the school is refused", async () => {
    const parentId = await newUser([ROLES.PARENT]);
    const child = await newChild();
    await link(parentId, child);
    await asAdmin(
      (tx) => tx`
        UPDATE app.students SET status = 'withdrawn'::app.student_status
        WHERE id = ${child.studentId}::uuid
      `,
    );

    await expectCode(
      await open(child.studentId, await tokenFor(parentId, [ROLES.PARENT])),
      403,
      "GUARDIAN_CHILD_UNAVAILABLE",
    );
  });
});

describe("rate limit", () => {
  test("a parent past the hourly budget gets 429 before anything is read", async () => {
    let calls = 0;
    const routes = new OpenAPIHono<AppEnv>();
    routes.use("*", async (c, next) => {
      c.set("auth", {
        userId: crypto.randomUUID(),
        schoolId: crypto.randomUUID(),
        roles: [ROLES.PARENT],
        channel: AUTH_CHANNELS.MOBILE,
        jti: crypto.randomUUID(),
      } as never);
      await next();
    });
    routes.route(
      "/",
      guardianSessionRoutes(
        // Never reached: the limiter refuses first.
        null as never,
        {} as never,
        async () => {
          calls += 1;
          return calls > 10 ? { allowed: false, retryAfter: 360 } : { allowed: true };
        },
      ),
    );

    calls = 10;
    const response = await routes.request(sessionPath(crypto.randomUUID()), { method: "POST" });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("360");
  });
});
