import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { AUTH_CHANNELS } from "../../auth/channels";

import { aiStudentSelfGate } from "./student-self-gate";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { TransactionSql } from "postgres";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_STUDENT_ID = "00000000-0000-4000-8000-000000000003";
const USER_ID = "00000000-0000-4000-8000-000000000004";

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

const auth: AuthContext = {
  userId: USER_ID,
  schoolId: SCHOOL_ID,
  roles: [ROLES.STUDENT],
  channel: AUTH_CHANNELS.API,
  jti: "jti-1",
  exp: Math.floor(Date.now() / 1000) + 900,
  entitlementsVer: 1,
  subscriptionStatus: "active",
};

/** A database whose only student record is STUDENT_ID, owned by USER_ID. */
function fakeDatabase() {
  const lookups: unknown[] = [];
  const result = (rows: unknown[]) =>
    Object.assign(Promise.resolve(rows), { execute: () => Promise.resolve() });
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("app.student_user_id")) {
      lookups.push(values[0]);
      return result([{ user_id: values[0] === STUDENT_ID ? USER_ID : null }]);
    }
    return result([]);
  }) as unknown as TransactionSql;
  (tx as unknown as { unsafe: unknown }).unsafe = async () => undefined;

  const database = Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => {
      await fn(tx);
    },
  });
  return { database, lookups };
}

function buildApp(database: Database) {
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    await next();
  });
  app.use("/api/ai/students/:studentId/*", aiStudentSelfGate({ database }));
  app.post("/api/ai/students/:studentId/ask", (c) => c.json({ ok: true }));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

describe("aiStudentSelfGate", () => {
  test("lets the student through on their own student record id", async () => {
    const { database } = fakeDatabase();
    const res = await buildApp(database).request(`/api/ai/students/${STUDENT_ID}/ask`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
  });

  test("refuses another student's id with 403 AUTHZ_FORBIDDEN", async () => {
    const { database } = fakeDatabase();
    const res = await buildApp(database).request(`/api/ai/students/${OTHER_STUDENT_ID}/ask`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);
  });

  test("refuses the caller's user id, which is not a student record id", async () => {
    const { database } = fakeDatabase();
    const res = await buildApp(database).request(`/api/ai/students/${USER_ID}/ask`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  test("leaves a malformed id to the route's validation without a lookup", async () => {
    const { database, lookups } = fakeDatabase();
    const res = await buildApp(database).request("/api/ai/students/not-a-uuid/ask", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(lookups).toEqual([]);
  });
});
