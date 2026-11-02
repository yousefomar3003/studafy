import { OpenAPIHono } from "@hono/zod-openapi";
import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../middleware/errorHandler";
import { AUTH_CHANNELS } from "../auth/channels";

import { platformRoutes } from "./routes";

import type { Database } from "../../db/client";
import type { Logger } from "../../logger";
import type { AuthContext } from "../../middleware/authContext";
import type { AppEnv } from "../../middleware/requestId";
import type { AuthChannel } from "../auth/channels";
import type { Role } from "@studafy/constants";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SCHOOL_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";

const silentLogger: Logger = {
  level: "info",
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

function auth(roles: readonly Role[], channel: AuthChannel = AUTH_CHANNELS.WEB): AuthContext {
  return {
    userId: USER_ID,
    schoolId: SCHOOL_ID,
    roles,
    channel,
    jti: "jti-1",
    entitlementsVer: 1,
    subscriptionStatus: "active",
  };
}

/** A database that fails the test if any route reaches it -- denials must happen before the DB. */
const untouchableDatabase = Object.assign((() => undefined) as unknown as Database, {
  begin: () => {
    throw new Error("database must not be reached");
  },
});

/** `withSystemTx` over a fake transaction whose every query answers `rows`. */
function databaseReturning(rows: unknown[]): Database {
  const tx = Object.assign((() => Promise.resolve(rows)) as unknown as Database, {
    unsafe: async () => [],
  });
  return Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  });
}

/**
 * `withSystemTx` over a fake transaction that answers the school-members queries by their text:
 * the school row, the counts, one page holding a single student, and nothing for the GUC and
 * audit writes.
 */
function membersDatabase(): Database {
  const answer = (sql: string): unknown[] => {
    if (sql.includes("FROM app.schools")) {
      return [{ id: OTHER_SCHOOL_ID, status: "active", created_at: new Date() }];
    }
    if (sql.includes("AS total")) return [{ total: 1 }];
    if (sql.includes("AS member_count")) return [{ member_count: 3 }];
    if (sql.includes("GROUP BY role")) return [{ role: "STUDENT", count: 1 }];
    if (sql.includes("WITH page")) {
      return [
        {
          id: USER_ID,
          display_name: "Sara Ali",
          email: "sara@school.test",
          status: "active",
          created_at: new Date("2026-01-01T00:00:00Z"),
          last_login_at: null,
          roles: ["STUDENT"],
          student_id: SCHOOL_ID,
          admission_number: "ADM-1",
          student_status: "enrolled",
          employee_number: null,
          employment_status: null,
          classes: ["G5-A"],
          guardians: null,
          children: null,
        },
      ];
    }
    return [];
  };
  const tx = Object.assign(
    ((strings: TemplateStringsArray) => {
      const rows = answer(Array.isArray(strings) ? strings.join("?") : "");
      return Object.assign(Promise.resolve(rows), { execute: () => Promise.resolve(rows) });
    }) as unknown as Database,
    { unsafe: async () => [], json: (value: unknown) => value },
  );
  return Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  });
}

function buildApp(authCtx: AuthContext, database: Database = untouchableDatabase) {
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", authCtx);
    c.set("locale", "en");
    c.set("log", silentLogger);
    await next();
  });
  app.route(
    "/",
    platformRoutes({ database, redis: null, paymentProvider: null, logger: silentLogger }),
  );
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

const json = (body: unknown) => ({
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("platform console authorization", () => {
  const schoolRoles: Role[] = [
    ROLES.ORG_ADMIN,
    ROLES.PRINCIPAL,
    ROLES.FINANCE,
    ROLES.SUPPORT_AGENT,
    ROLES.INSTRUCTOR,
    ROLES.STUDENT,
    ROLES.PARENT,
    ROLES.GUEST,
  ];

  for (const role of schoolRoles) {
    test(`${role} cannot read the platform overview`, async () => {
      const res = await buildApp(auth([role])).request("/api/platform/overview");
      expect(res.status).toBe(403);
    });

    test(`${role} cannot list a school's members`, async () => {
      const res = await buildApp(auth([role])).request(
        `/api/platform/schools/${OTHER_SCHOOL_ID}/members`,
      );
      expect(res.status).toBe(403);
    });

    test(`${role} cannot change a school's status`, async () => {
      const res = await buildApp(auth([role])).request(
        `/api/platform/schools/${OTHER_SCHOOL_ID}/status`,
        json({ status: "suspended", reason: "Unpaid invoices" }),
      );
      expect(res.status).toBe(403);
    });
  }

  test("a SUPER_ADMIN on a mobile session is refused -- the console is web-only", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN], AUTH_CHANNELS.MOBILE)).request(
      "/api/platform/overview",
    );
    expect(res.status).toBe(403);
  });

  test("a SUPER_ADMIN reads the overview", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN]), databaseReturning([])).request(
      "/api/platform/overview",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalSchools: number; schoolsByStatus: object };
    expect(body.totalSchools).toBe(0);
    expect(body.schoolsByStatus).toEqual({
      registered: 0,
      pending: 0,
      active: 0,
      suspended: 0,
      archived: 0,
    });
  });
});

describe("platform school members", () => {
  test("a SUPER_ADMIN lists a school's members with role counts", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN]), membersDatabase()).request(
      `/api/platform/schools/${OTHER_SCHOOL_ID}/members?role=STUDENT&search=sara`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      memberCount: number;
      roleCounts: Record<string, number>;
      members: { userId: string; student: { classes: string[] } | null; children: unknown[] }[];
    };
    expect(body.total).toBe(1);
    expect(body.memberCount).toBe(3);
    expect(body.roleCounts).toEqual({ STUDENT: 1 });
    expect(body.members[0]!.userId).toBe(USER_ID);
    expect(body.members[0]!.student?.classes).toEqual(["G5-A"]);
    expect(body.members[0]!.children).toEqual([]);
  });

  test("an unknown role filter is rejected before the database", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(
      `/api/platform/schools/${OTHER_SCHOOL_ID}/members?role=JANITOR`,
    );
    expect(res.status).toBe(400);
  });

  test("a non-uuid school id is rejected before the database", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(
      "/api/platform/schools/not-a-uuid/members",
    );
    expect(res.status).toBe(400);
  });
});

describe("platform console validation", () => {
  test("a status change without a reason is rejected before the database", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(
      `/api/platform/schools/${OTHER_SCHOOL_ID}/status`,
      json({ status: "suspended" }),
    );
    expect(res.status).toBe(400);
  });

  test("an unknown lifecycle status is rejected", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(
      `/api/platform/schools/${OTHER_SCHOOL_ID}/status`,
      json({ status: "deleted", reason: "Testing an invalid state" }),
    );
    expect(res.status).toBe(400);
  });

  test("an unknown feature flag is rejected", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(
      `/api/platform/schools/${OTHER_SCHOOL_ID}/feature-flags/not.a.flag`,
      { ...json({ enabled: true }), method: "PUT" },
    );
    expect(res.status).toBe(400);
  });

  test("a cross-school user lookup needs a real email", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(
      "/api/platform/users/lookup?email=nope",
    );
    expect(res.status).toBe(400);
  });
});
