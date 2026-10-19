import { ERROR_CODES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../coded-http-exception";
import { createLogger } from "../logger";

import { errorHandlerMiddleware } from "./errorHandler";

import type { AuthContext } from "./authContext";
import type { AppEnv } from "./requestId";

const AUTH = {
  userId: "11111111-1111-4111-8111-111111111111",
  schoolId: "22222222-2222-4222-8222-222222222222",
} as AuthContext;

/**
 * A bare app with only the error handler and a stub of the request-scoped context it reads —
 * reporting is the unit under test here, so the full createApp() stack (covered by
 * errorHandler.test.ts) would only add noise. `reportError` is the injected monitoring seam.
 */
const buildApp = (throwing: () => never) => {
  const reportError = mock();
  const lines: string[] = [];
  const app = new Hono<AppEnv>();
  app.onError(
    errorHandlerMiddleware(createLogger({ destination: (l) => lines.push(l) }), reportError),
  );
  app.use("*", async (c, next) => {
    c.set("requestId", "33333333-3333-4333-8333-333333333333");
    c.set("auth", AUTH);
    await next();
  });
  app.get("/api/students/:id", () => throwing());
  return { app, reportError, lines };
};

describe("error monitoring", () => {
  test.each([
    ["an unknown error", () => new Error("connection reset")],
    [
      "a 5xx CodedHttpException",
      () => new CodedHttpException(502, ERROR_CODES.INTERNAL_ERROR, "upstream failed"),
    ],
    ["a 5xx HTTPException", () => new HTTPException(503, { message: "storage unavailable" })],
  ])("reports %s with request, route, tenant and user ids only", async (_label, make) => {
    const error = make();
    const { app, reportError } = buildApp(() => {
      throw error;
    });

    const res = await app.request("/api/students/student-42?email=a@b.com");

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = reportError.mock.calls[0]!;
    expect(reported).toBe(error);
    expect(context).toEqual({
      tags: {
        request_id: "33333333-3333-4333-8333-333333333333",
        route: "/api/students/:id",
        school_id: AUTH.schoolId,
        code: expect.any(String),
      },
      userId: AUTH.userId,
      extra: { status: res.status, method: "GET" },
    });
    // The concrete path (with its id and query string) never reaches the report.
    expect(JSON.stringify(context)).not.toContain("student-42");
    expect(JSON.stringify(context)).not.toContain("a@b.com");
  });

  test.each([
    [
      "a 4xx CodedHttpException",
      () => new CodedHttpException(403, ERROR_CODES.AUTHZ_FORBIDDEN, "not your school"),
    ],
    ["a 4xx HTTPException", () => new HTTPException(404, { message: "no such student" })],
  ])("does not report %s", async (_label, make) => {
    const { app, reportError, lines } = buildApp(() => {
      throw make();
    });

    const res = await app.request("/api/students/student-42");

    expect(res.status).toBeLessThan(500);
    expect(reportError).not.toHaveBeenCalled();
    // Still logged, exactly as before monitoring existed.
    expect(lines).toHaveLength(1);
  });

  test("reports before logging, so the log line's forwarding can skip the same error", async () => {
    const order: string[] = [];
    const reportError = mock(() => order.push("report"));
    const app = new Hono<AppEnv>();
    app.onError(
      errorHandlerMiddleware(createLogger({ destination: () => order.push("log") }), reportError),
    );
    app.get("/boom", () => {
      throw new Error("boom");
    });

    await app.request("/boom");

    expect(order).toEqual(["report", "log"]);
  });
});
