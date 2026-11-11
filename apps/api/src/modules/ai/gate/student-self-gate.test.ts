import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { beforeEach, describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { AUTH_CHANNELS } from "../../auth/channels";
import { AI_DATA_SHARING_DISCLOSURE } from "../consent/disclosure";

import { aiConsentGate } from "./consent-gate";
import { aiStudentSelfGate, clearAiStudentSelfCache } from "./student-self-gate";

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

/**
 * A database whose only student record is STUDENT_ID, owned by USER_ID. `consented` decides whether
 * USER_ID holds a live consent to the current disclosure. Counts every transaction it opens.
 */
function fakeDatabase(options: { consented?: boolean } = {}) {
  const lookups: unknown[] = [];
  const consentLookups: unknown[] = [];
  let transactions = 0;
  const result = (rows: unknown[]) =>
    Object.assign(Promise.resolve(rows), { execute: () => Promise.resolve() });
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("app.student_user_id")) {
      lookups.push(values[0]);
      return result([{ user_id: values[0] === STUDENT_ID ? USER_ID : null }]);
    }
    if (sql.includes("app.ai_data_sharing_consents")) {
      consentLookups.push(values[0]);
      return result(
        options.consented
          ? [
              {
                id: "00000000-0000-4000-8000-0000000000c1",
                disclosure_version: AI_DATA_SHARING_DISCLOSURE.version,
                provider: "together",
                data_categories: ["questions"],
                granted_at: new Date("2026-01-01T00:00:00Z"),
              },
            ]
          : [],
      );
    }
    return result([]);
  }) as unknown as TransactionSql;
  (tx as unknown as { unsafe: unknown }).unsafe = async () => undefined;

  const database = Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => {
      transactions += 1;
      await fn(tx);
    },
  });
  return { database, lookups, consentLookups, transactions: () => transactions };
}

function buildApp(database: Database, options: { consentGate?: boolean } = {}) {
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    await next();
  });
  app.use("/api/ai/students/:studentId/*", aiStudentSelfGate({ database }));
  if (options.consentGate) app.use("/api/ai/*", aiConsentGate({ database }));
  app.post("/api/ai/students/:studentId/ask", (c) => c.json({ ok: true }));
  app.post("/api/ai/students/:studentId/search", (c) => c.json({ ok: true }));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

beforeEach(() => {
  clearAiStudentSelfCache();
});

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

  test("a confirmed verdict is reused: the second request makes no lookup", async () => {
    const { database, lookups, transactions } = fakeDatabase();
    const app = buildApp(database);
    for (let i = 0; i < 2; i += 1) {
      const res = await app.request(`/api/ai/students/${STUDENT_ID}/search`, { method: "POST" });
      expect(res.status).toBe(200);
    }
    expect(lookups).toEqual([STUDENT_ID]);
    expect(transactions()).toBe(1);
  });

  test("a refusal is never cached", async () => {
    const { database, lookups } = fakeDatabase();
    const app = buildApp(database);
    for (let i = 0; i < 2; i += 1) {
      const res = await app.request(`/api/ai/students/${OTHER_STUDENT_ID}/search`, {
        method: "POST",
      });
      expect(res.status).toBe(403);
    }
    expect(lookups).toEqual([OTHER_STUDENT_ID, OTHER_STUDENT_ID]);
  });
});

describe("aiStudentSelfGate with aiConsentGate", () => {
  test("a model call reads self and consent in one transaction", async () => {
    const { database, consentLookups, transactions } = fakeDatabase({ consented: true });
    const res = await buildApp(database, { consentGate: true }).request(
      `/api/ai/students/${STUDENT_ID}/ask`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(consentLookups).toHaveLength(1);
    expect(transactions()).toBe(1);
  });

  test("consent is re-read on every request, so a withdrawal applies at once", async () => {
    const { database, consentLookups, transactions } = fakeDatabase({ consented: false });
    const app = buildApp(database, { consentGate: true });
    for (let i = 0; i < 2; i += 1) {
      const res = await app.request(`/api/ai/students/${STUDENT_ID}/ask`, { method: "POST" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe(ERROR_CODES.AI_CONSENT_REQUIRED);
    }
    // First request: one shared transaction. Second: self cached, the consent gate's own one.
    expect(consentLookups).toHaveLength(2);
    expect(transactions()).toBe(2);
  });
});
