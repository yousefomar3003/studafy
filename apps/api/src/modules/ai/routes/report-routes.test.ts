import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";

import { aiReportRoutes } from "./report-routes";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { TransactionSql } from "postgres";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = STUDENT_ID;
const MESSAGE_ID = "00000000-0000-4000-8000-000000000021";
const REPORT_ID = "00000000-0000-4000-8000-000000000031";

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
  entitlementsVer: 1,
  subscriptionStatus: "active",
};

function fakeDatabase(opts: { messageExists?: boolean; duplicateReport?: boolean } = {}) {
  const queries: string[] = [];
  const messageExists = opts.messageExists ?? true;
  const duplicateReport = opts.duplicateReport ?? false;

  const tx = ((strings: TemplateStringsArray) => {
    const sql = strings.join("\u0000");
    queries.push(sql);

    if (sql.includes("FROM app.ai_messages")) {
      return Object.assign(Promise.resolve(messageExists ? [{ id: MESSAGE_ID }] : []), {
        execute: () => Promise.resolve(),
      });
    }
    if (sql.includes("INSERT INTO app.ai_answer_reports")) {
      if (duplicateReport) {
        const err = new Error("duplicate key") as Error & { code: string };
        err.code = "23505";
        return Object.assign(Promise.reject(err), { execute: () => Promise.resolve() });
      }
      return Object.assign(Promise.resolve([{ id: REPORT_ID }]), {
        execute: () => Promise.resolve(),
      });
    }
    return Object.assign(Promise.resolve([]), { execute: () => Promise.resolve() });
  }) as unknown as TransactionSql;

  (tx as unknown as { unsafe: unknown }).unsafe = async () => undefined;

  const database = Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => {
      await fn(tx);
    },
  });

  return { database, queries };
}

function buildReportApp(database: Database): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    await next();
  });
  app.route("/", aiReportRoutes({ database }));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

const reportUrl = `/api/ai/students/${STUDENT_ID}/messages/${MESSAGE_ID}/report`;

async function postReport(
  app: OpenAPIHono<AppEnv>,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(reportUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai/students/{studentId}/messages/{messageId}/report", () => {
  test("stores a report flag for teacher review and returns 201", async () => {
    const { database } = fakeDatabase();
    const app = buildReportApp(database);

    const res = await postReport(app, { reason: "This answer is incorrect" });
    const body = (await res.json()) as { report_id: string; message: string };

    expect(res.status).toBe(201);
    expect(body.report_id).toBe(REPORT_ID);
    expect(body.message).toContain("reported");
  });

  test("returns 404 when the message does not exist", async () => {
    const { database } = fakeDatabase({ messageExists: false });
    const app = buildReportApp(database);

    const res = await postReport(app, { reason: "Bad answer" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  test("returns 409 on duplicate report", async () => {
    const { database } = fakeDatabase({ duplicateReport: true });
    const app = buildReportApp(database);

    const res = await postReport(app, { reason: "Already reported this" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe(ERROR_CODES.AI_ANSWER_REPORTED);
  });

  test("returns 400 on empty reason", async () => {
    const { database } = fakeDatabase();
    const app = buildReportApp(database);

    const res = await postReport(app, { reason: "   " });

    expect(res.status).toBe(400);
  });
});
