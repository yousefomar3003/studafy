import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { AUTH_CHANNELS } from "../../auth/channels";
import { AI_DATA_SHARING_DISCLOSURE, isAiModelCallPath } from "../consent/disclosure";
import { aiConsentGate } from "../gate/consent-gate";

import { aiConsentRoutes } from "./consent-routes";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const CONSENT_ID = "00000000-0000-4000-8000-0000000000c1";

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

interface ConsentRow {
  id: string;
  disclosure_version: string;
  provider: string;
  data_categories: string[];
  granted_at: Date;
  withdrawn_at: Date | null;
}

/**
 * In-memory stand-in for app.ai_data_sharing_consents and app.audit_logs, answering the statements
 * consent/persistence.ts issues. `audits` collects the target table and action of every audit row.
 */
function fakeDatabase(initial: ConsentRow[] = []) {
  const rows = [...initial];
  const audits: { action: string; table: string; targetId: string }[] = [];

  const txFn = (...args: unknown[]) => {
    const sql = (args[0] as string[]).join("|");
    let result: unknown[] = [];

    if (sql.includes("INSERT INTO app.audit_logs")) {
      audits.push({
        action: args[1] as string,
        table: args[2] as string,
        targetId: args[3] as string,
      });
    } else if (sql.includes("INSERT INTO app.ai_data_sharing_consents")) {
      const row: ConsentRow = {
        id: CONSENT_ID,
        disclosure_version: args[3] as string,
        provider: args[4] as string,
        data_categories: args[5] as string[],
        granted_at: new Date("2026-09-28T10:00:00Z"),
        withdrawn_at: null,
      };
      rows.push(row);
      result = [row];
    } else if (sql.includes("UPDATE app.ai_data_sharing_consents")) {
      const row = rows.find((r) => r.id === args[1] && r.withdrawn_at === null);
      if (row) {
        row.withdrawn_at = new Date("2026-09-28T11:00:00Z");
        result = [{ withdrawn_at: row.withdrawn_at }];
      }
    } else if (sql.includes("FROM app.ai_data_sharing_consents")) {
      result = rows.filter((r) => r.withdrawn_at === null);
    }

    return Object.assign(Promise.resolve(result), { execute: () => Promise.resolve() });
  };
  const tx = Object.assign(txFn, { json: (value: unknown) => value });
  const database = Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => {
      await fn(tx);
    },
  });
  return { database, rows, audits };
}

function liveRow(version: string): ConsentRow {
  return {
    id: CONSENT_ID,
    disclosure_version: version,
    provider: "anthropic",
    data_categories: ["questions"],
    granted_at: new Date("2026-01-01T00:00:00Z"),
    withdrawn_at: null,
  };
}

/** The consent routes plus the gate in front of one stand-in model route and one non-model route. */
function buildApp(database: Database) {
  const modelCalls: string[] = [];
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    await next();
  });
  app.use("/api/ai/*", aiConsentGate({ database }));
  app.route("/", aiConsentRoutes({ database }));
  app.post("/api/ai/students/:studentId/ask", (c) => {
    modelCalls.push(c.req.path);
    return c.json({ ok: true });
  });
  app.post("/api/ai/students/:studentId/search", (c) => c.json({ ok: true }));
  app.onError(errorHandlerMiddleware(silentLogger));
  return { app, modelCalls };
}

const json = { "content-type": "application/json" };

interface StatusBody {
  disclosure: { provider: { name: string }; dataCategories: string[] };
  consent: { disclosureVersion: string; provider: string } | null;
}

async function statusBody(res: Response): Promise<StatusBody> {
  return (await res.json()) as StatusBody;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code;
}

describe("GET /api/ai/consent", () => {
  test("serves the disclosure with no consent when none was granted", async () => {
    const { app } = buildApp(fakeDatabase().database);
    const res = await app.request("/api/ai/consent");

    expect(res.status).toBe(200);
    const body = await statusBody(res);
    expect(body.consent).toBeNull();
    expect(body.disclosure.provider.name).toBe("Anthropic");
    expect(body.disclosure.dataCategories).toEqual([
      "questions",
      "study_materials",
      "account_identifier",
    ]);
  });

  test("treats a live consent to an older disclosure version as no consent", async () => {
    const { app } = buildApp(fakeDatabase([liveRow("2020-01-01")]).database);
    const body = await statusBody(await app.request("/api/ai/consent"));
    expect(body.consent).toBeNull();
  });
});

describe("PUT /api/ai/consent", () => {
  test("records consent to the current disclosure and audits it", async () => {
    const { database, rows, audits } = fakeDatabase();
    const { app } = buildApp(database);

    const res = await app.request("/api/ai/consent", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ disclosureVersion: AI_DATA_SHARING_DISCLOSURE.version }),
    });

    expect(res.status).toBe(200);
    const body = await statusBody(res);
    expect(body.consent?.disclosureVersion).toBe(AI_DATA_SHARING_DISCLOSURE.version);
    expect(body.consent?.provider).toBe("anthropic");
    expect(rows).toHaveLength(1);
    expect(audits).toEqual([
      { action: "insert", table: "ai_data_sharing_consents", targetId: CONSENT_ID },
    ]);
  });

  test("is idempotent for an existing current consent", async () => {
    const { database, rows, audits } = fakeDatabase([liveRow(AI_DATA_SHARING_DISCLOSURE.version)]);
    const { app } = buildApp(database);

    const res = await app.request("/api/ai/consent", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ disclosureVersion: AI_DATA_SHARING_DISCLOSURE.version }),
    });

    expect(res.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(audits).toHaveLength(0);
  });

  test("supersedes a consent to an older disclosure version", async () => {
    const { database, rows, audits } = fakeDatabase([liveRow("2020-01-01")]);
    const { app } = buildApp(database);

    await app.request("/api/ai/consent", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ disclosureVersion: AI_DATA_SHARING_DISCLOSURE.version }),
    });

    expect(rows[0]!.withdrawn_at).not.toBeNull();
    expect(rows).toHaveLength(2);
    expect(audits.map((a) => a.action)).toEqual(["update", "insert"]);
  });

  test("refuses a grant against a disclosure version that is not current", async () => {
    const { database, rows } = fakeDatabase();
    const { app } = buildApp(database);

    const res = await app.request("/api/ai/consent", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ disclosureVersion: "2020-01-01" }),
    });

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe(ERROR_CODES.AI_CONSENT_DISCLOSURE_OUTDATED);
    expect(rows).toHaveLength(0);
  });
});

describe("DELETE /api/ai/consent", () => {
  test("withdraws the live consent and audits it", async () => {
    const { database, rows, audits } = fakeDatabase([liveRow(AI_DATA_SHARING_DISCLOSURE.version)]);
    const { app } = buildApp(database);

    const res = await app.request("/api/ai/consent", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect((await statusBody(res)).consent).toBeNull();
    expect(rows[0]!.withdrawn_at).not.toBeNull();
    expect(audits).toEqual([
      { action: "update", table: "ai_data_sharing_consents", targetId: CONSENT_ID },
    ]);
  });

  test("is a no-op without a live consent", async () => {
    const { database, audits } = fakeDatabase();
    const { app } = buildApp(database);

    const res = await app.request("/api/ai/consent", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(audits).toHaveLength(0);
  });
});

describe("aiConsentGate", () => {
  const askPath = `/api/ai/students/${USER_ID}/ask`;

  test("refuses a model-calling route without consent, before the handler runs", async () => {
    const { app, modelCalls } = buildApp(fakeDatabase().database);

    const res = await app.request(askPath, { method: "POST" });

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe(ERROR_CODES.AI_CONSENT_REQUIRED);
    expect(modelCalls).toHaveLength(0);
  });

  test("admits a model-calling route with a current consent", async () => {
    const { app, modelCalls } = buildApp(
      fakeDatabase([liveRow(AI_DATA_SHARING_DISCLOSURE.version)]).database,
    );

    const res = await app.request(askPath, { method: "POST" });

    expect(res.status).toBe(200);
    expect(modelCalls).toEqual([askPath]);
  });

  test("refuses again after consent is withdrawn", async () => {
    const { app, modelCalls } = buildApp(
      fakeDatabase([liveRow(AI_DATA_SHARING_DISCLOSURE.version)]).database,
    );

    await app.request("/api/ai/consent", { method: "DELETE" });
    const res = await app.request(askPath, { method: "POST" });

    expect(res.status).toBe(403);
    expect(modelCalls).toHaveLength(0);
  });

  test("passes through routes that never reach the provider", async () => {
    const { app } = buildApp(fakeDatabase().database);

    const res = await app.request(`/api/ai/students/${USER_ID}/search`, { method: "POST" });

    expect(res.status).toBe(200);
  });
});

describe("isAiModelCallPath", () => {
  test("matches exactly the provider-calling routes", () => {
    for (const suffix of [
      "generate",
      "ask",
      "summarize",
      "concepts",
      "explain",
      "quizzes",
      "decks",
      "exams",
    ]) {
      expect(isAiModelCallPath(`/api/ai/students/s/${suffix}`)).toBe(true);
    }
    for (const path of [
      "/api/ai/usage",
      "/api/ai/consent",
      "/api/ai/students/s/search",
      "/api/ai/students/s/quizzes/q/grade",
      "/api/ai/students/s/decks/d/review",
      "/api/ai/students/s/exams/e",
      "/api/ai/students/s/exams/e/submit",
      "/api/ai/students/s/messages/m/report",
    ]) {
      expect(isAiModelCallPath(path)).toBe(false);
    }
  });
});
