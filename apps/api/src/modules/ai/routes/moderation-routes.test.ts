import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES, type Role } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";

import { aiModerationRoutes } from "./moderation-routes";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { ReportStatus } from "../moderation/reports";
import type { TransactionSql } from "postgres";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000009";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
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

function reportRow(status: ReportStatus, respondBy = new Date(Date.now() - 60_000)) {
  return {
    id: REPORT_ID,
    student_id: STUDENT_ID,
    content_type: "quiz",
    content_id: "00000000-0000-4000-8000-000000000022",
    moderation_decision_id: null,
    source: "user_report",
    reporter_id: STUDENT_ID,
    reason_category: "child_safety",
    reason: null,
    priority: "urgent",
    respond_by: respondBy,
    status,
    resolution_note: null,
    reviewed_by: status === "pending" ? null : ADMIN_ID,
    reviewed_at: status === "pending" ? null : new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    content_snapshot: "Q1. ...",
  };
}

/**
 * A tx that answers the three statements the queue makes. `updateWins: false` simulates a second
 * moderator changing the report between this request's read and its conditional update.
 */
function fakeDatabase(opts: { status?: ReportStatus | null; updateWins?: boolean } = {}) {
  const status = opts.status === undefined ? "pending" : opts.status;
  const statements: string[] = [];
  const result = (rows: unknown[]) =>
    Object.assign(Promise.resolve(rows), { execute: () => Promise.resolve() });

  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    statements.push(sql);
    if (sql.includes("INSERT INTO app.audit_logs")) return result([]);
    if (sql.includes("UPDATE app.ai_content_reports")) {
      if (opts.updateWins === false) return result([]);
      return result([{ ...reportRow(values[0] as ReportStatus), resolution_note: values[1] }]);
    }
    if (sql.includes("count(*) OVER ()")) {
      return result(status ? [{ ...reportRow(status), total: "1" }] : []);
    }
    if (sql.includes("FROM app.ai_content_reports")) {
      return result(status ? [reportRow(status)] : []);
    }
    return result([]);
  }) as unknown as TransactionSql;
  Object.assign(tx, { unsafe: (text: string) => text, json: (value: unknown) => value });

  const database = Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => {
      await fn(tx);
    },
  });
  return { database, statements };
}

function buildApp(database: Database, role: Role = ROLES.ORG_ADMIN) {
  const auth: AuthContext = {
    userId: ADMIN_ID,
    schoolId: SCHOOL_ID,
    roles: [role],
    channel: AUTH_CHANNELS.API,
    jti: "jti-1",
    entitlementsVer: 1,
    subscriptionStatus: "active",
  };
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    c.set("log", silentLogger);
    await next();
  });
  app.route("/", aiModerationRoutes({ database }));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

const reportUrl = `/api/ai/moderation/reports/${REPORT_ID}`;

function patch(app: OpenAPIHono<AppEnv>, body: Record<string, unknown>) {
  return app.request(reportUrl, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/ai/moderation/reports", () => {
  test("lists open reports without their snapshots, flagging overdue ones", async () => {
    const { database } = fakeDatabase();
    const res = await buildApp(database).request("/api/ai/moderation/reports");
    const body = (await res.json()) as {
      reports: Record<string, unknown>[];
      total: number;
    };

    expect(res.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.reports[0]!.overdue).toBe(true);
    expect(body.reports[0]!.content_snapshot).toBeUndefined();
  });

  test("teachers cannot read the queue", async () => {
    const { database } = fakeDatabase();
    const res = await buildApp(database, ROLES.INSTRUCTOR).request("/api/ai/moderation/reports");

    expect(res.status).toBe(403);
  });

  test("students cannot read the queue", async () => {
    const { database } = fakeDatabase();
    const res = await buildApp(database, ROLES.STUDENT).request("/api/ai/moderation/reports");

    expect(res.status).toBe(403);
  });
});

describe("GET /api/ai/moderation/reports/{reportId}", () => {
  test("returns the snapshot and audit-logs the read", async () => {
    const { database, statements } = fakeDatabase();
    const res = await buildApp(database).request(reportUrl);
    const body = (await res.json()) as { content_snapshot: string };

    expect(res.status).toBe(200);
    expect(body.content_snapshot).toBe("Q1. ...");
    expect(statements.some((sql) => sql.includes("INSERT INTO app.audit_logs"))).toBe(true);
  });

  test("404 AI_REPORT_NOT_FOUND for an unknown report", async () => {
    const { database } = fakeDatabase({ status: null });
    const res = await buildApp(database).request(reportUrl);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.AI_REPORT_NOT_FOUND);
  });
});

describe("PATCH /api/ai/moderation/reports/{reportId}", () => {
  test("claims a pending report without a note", async () => {
    const { database, statements } = fakeDatabase();
    const res = await patch(buildApp(database), { status: "in_review" });
    const body = (await res.json()) as { status: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe("in_review");
    expect(statements.some((sql) => sql.includes("INSERT INTO app.audit_logs"))).toBe(true);
  });

  test("escalating requires a resolution note", async () => {
    const { database } = fakeDatabase({ status: "in_review" });
    const res = await patch(buildApp(database), { status: "escalated" });

    expect(res.status).toBe(400);
  });

  test("escalates with the external reference recorded", async () => {
    const { database } = fakeDatabase({ status: "in_review" });
    const res = await patch(buildApp(database), {
      status: "escalated",
      resolution_note: "Reported to NCMEC CyberTipline, report #123",
    });
    const body = (await res.json()) as { status: string; resolution_note: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe("escalated");
    expect(body.resolution_note).toContain("CyberTipline");
  });

  test("409 AI_REPORT_INVALID_TRANSITION when reopening a closed report", async () => {
    const { database } = fakeDatabase({ status: "dismissed" });
    const res = await patch(buildApp(database), { status: "in_review" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe(ERROR_CODES.AI_REPORT_INVALID_TRANSITION);
  });

  test("409 when another moderator changed the report first", async () => {
    const { database } = fakeDatabase({ updateWins: false });
    const res = await patch(buildApp(database), { status: "in_review" });

    expect(res.status).toBe(409);
  });

  test("teachers cannot review", async () => {
    const { database } = fakeDatabase();
    const res = await patch(buildApp(database, ROLES.INSTRUCTOR), { status: "in_review" });

    expect(res.status).toBe(403);
  });
});
