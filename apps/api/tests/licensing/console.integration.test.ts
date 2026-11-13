/**
 * The license console's catalog and cross-school reads against a real database (session 4 of
 * docs/billing/feature-licensing.md): features, tiers with features and prices, every school's
 * licenses (with the expiring / unpaid / nearly-full filters) and change requests, one school's
 * license overview, usage next to revenue, and the routes' permissions.
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import {
  acceptQuote,
  assignSeats,
  createChangeRequest,
  createLicense,
  createQuote,
  recordPayment,
  runLicenseChange,
  sendQuote,
  transitionLicense,
} from "../../src/modules/licensing";
import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createStudent,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { LicenseActor, LicensingDeps } from "../../src/modules/licensing";
import type { TestApp, TestDatabase } from "../harness";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const logger = createLogger({ destination: () => undefined });
const DAY = 86_400_000;

let db: TestDatabase;
let api: TestApp;
let hq: string;
let operator: LicenseActor;
let studentTier = "";

function deps(): LicensingDeps {
  return { database: db.sql, redis: null, logger, providers: { stripe: null, googlePlay: null } };
}

/** A flow's result, whether the service hands back a `Changed<T>` or a plain value. */
type Unwrapped<T> = T extends { result: infer R; versions: Map<string, number> } ? R : T;

function change<T>(
  schoolId: string,
  actor: LicenseActor,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<Unwrapped<T>> {
  return runLicenseChange(deps(), schoolId, actor, async (tx) => {
    const out = (await fn(tx)) as unknown;
    if (out && typeof out === "object" && "versions" in out && "result" in out) {
      return out as { result: Unwrapped<T>; versions: Map<string, number>; pending: [] };
    }
    return { result: out as Unwrapped<T>, versions: new Map<string, number>(), pending: [] };
  }).then((r) => r.result);
}

const json = (body: unknown) => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

function asOperator(method: string, path: string, body?: unknown) {
  return authenticatedRequest(
    api,
    method,
    path,
    {
      schoolId: hq,
      userId: operator.userId,
      roles: [ROLES.SUPER_ADMIN],
      channel: AUTH_CHANNELS.WEB,
    },
    body === undefined ? undefined : json(body),
  );
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);
  const created = createTestApp({ database: db.sql });
  await created.ready;
  api = created;

  hq = (await createSchool(db.sql, { name: "Studafy HQ" })).id;
  const op = await createUser(db.sql, hq, { email: "console-ops@studafy.test" });
  await assignRole(db.sql, hq, op.id, "SUPER_ADMIN");
  operator = { kind: "platform", userId: op.id, homeSchoolId: hq };
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

async function school(name: string, students = 0) {
  const schoolId = (await createSchool(db.sql, { name })).id;
  const admin = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, admin.id, "ORG_ADMIN");
  const created = [];
  for (let i = 0; i < students; i += 1) {
    created.push(
      await createStudent(db.sql, schoolId, { firstName: "Con", lastName: `Sole ${i}` }),
    );
  }
  return {
    schoolId,
    adminId: admin.id,
    admin: { kind: "school", userId: admin.id, homeSchoolId: schoolId } as LicenseActor,
    students: created,
  };
}

async function activeLicense(schoolId: string, seats: number, endsInDays: number) {
  return change(schoolId, operator, async (tx) => {
    const license = await createLicense(
      tx,
      schoolId,
      {
        startsAt: new Date(Date.now() - 10 * DAY),
        endsAt: new Date(Date.now() + endsInDays * DAY),
        currencyCode: "USD",
        includeFamilyPlus: false,
        student: { planId: studentTier, seats },
      },
      operator,
    );
    return transitionLicense(tx, schoolId, license.id, "active", operator);
  });
}

describe("features", () => {
  integrationTest("lists every registered feature and pauses one, audited", async () => {
    const listed = (await (await asOperator("GET", "/api/platform/features")).json()) as {
      features: { key: string; audience: string; unit: string | null; status: string }[];
    };
    expect(listed.features.find((f) => f.key === "ai_tutor")).toMatchObject({
      audience: "student",
      unit: "messages",
      status: "active",
    });
    expect(listed.features.find((f) => f.key === "family_plus")?.unit).toBeNull();

    const paused = await asOperator("PATCH", "/api/platform/features/notebook", {
      displayName: "Smart notebook",
      status: "paused",
    });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ displayName: "Smart notebook", status: "paused" });

    const [audit] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.audit_logs
      WHERE school_id = ${hq}::uuid AND target_table = 'features' AND actor_id = ${operator.userId}::uuid
    `;
    expect(audit!.count).toBe(1);
    expect(
      (await asOperator("PATCH", "/api/platform/features/nope", { status: "paused" })).status,
    ).toBe(400);
  });
});

describe("tiers", () => {
  integrationTest("creates a tier with features and prices, then replaces them", async () => {
    const created = await asOperator("POST", "/api/platform/tiers", {
      code: "student_plus_console",
      audience: "student",
      displayName: "Student Plus",
      rank: 7,
      includesAllFeatures: false,
      features: [
        { key: "ai_tutor", monthlyLimit: 300 },
        { key: "study_tools", monthlyLimit: null },
      ],
      prices: [
        { currencyCode: "USD", amountMinor: 3000 },
        { currencyCode: "JOD", amountMinor: 2100 },
      ],
    });
    expect(created.status).toBe(201);
    const tier = (await created.json()) as { id: string; prices: { currencyCode: string }[] };
    studentTier = tier.id;
    expect(tier).toMatchObject({
      audience: "student",
      rank: 7,
      features: [
        { key: "ai_tutor", monthlyLimit: 300 },
        { key: "study_tools", monthlyLimit: null },
      ],
      inUse: 0,
    });
    expect(tier.prices.map((p) => p.currencyCode)).toEqual(["JOD", "USD"]);

    // Another active student tier cannot take rank 7; a teacher feature is refused.
    const clash = await asOperator("POST", "/api/platform/tiers", {
      code: "student_clash",
      audience: "student",
      displayName: "Clash",
      rank: 7,
      includesAllFeatures: false,
      features: [],
      prices: [],
    });
    expect(clash.status).toBe(409);
    const wrongAudience = await asOperator("POST", "/api/platform/tiers", {
      code: "student_wrong",
      audience: "student",
      displayName: "Wrong",
      rank: 8,
      includesAllFeatures: false,
      features: [{ key: "auto_grading", monthlyLimit: 10 }],
      prices: [],
    });
    expect(wrongAudience.status).toBe(422);

    // Replace: JOD left out is switched off, not deleted; the limit changes.
    const updated = await asOperator("PUT", `/api/platform/tiers/${tier.id}`, {
      displayName: "Student Plus",
      rank: 7,
      includesAllFeatures: true,
      features: [{ key: "ai_tutor", monthlyLimit: 500 }],
      prices: [{ currencyCode: "USD", amountMinor: 3200 }],
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      includesAllFeatures: true,
      features: [{ key: "ai_tutor", monthlyLimit: 500 }],
      prices: [
        { currencyCode: "JOD", amountMinor: 2100, isActive: false },
        { currencyCode: "USD", amountMinor: 3200, isActive: true },
      ],
    });
    const listed = (await (await asOperator("GET", "/api/platform/tiers")).json()) as {
      tiers: { id: string }[];
    };
    expect(listed.tiers.some((t) => t.id === tier.id)).toBe(true);
  });
});

describe("licenses across schools", () => {
  integrationTest(
    "filters by expiring, unpaid and nearly full; lists change requests",
    async () => {
      // Needs the tier from the test above.
      expect(studentTier).not.toBe("");
      const ending = await school("Console Ending", 2);
      const healthy = await school("Console Healthy");
      const unpaid = await school("Console Unpaid");

      const endingLicense = await activeLicense(ending.schoolId, 2, 20);
      await change(ending.schoolId, ending.admin, (tx) =>
        assignSeats(
          tx,
          ending.schoolId,
          endingLicense.id,
          { audience: "student", userIds: ending.students.map((s) => s.userId) },
          ending.admin,
        ),
      );
      await activeLicense(healthy.schoolId, 50, 300);
      const quote = await change(unpaid.schoolId, operator, async (tx) => {
        const q = await createQuote(
          tx,
          unpaid.schoolId,
          {
            kind: "new",
            currencyCode: "USD",
            months: 12,
            student: { planId: studentTier, seats: 10 },
          },
          operator,
        );
        return sendQuote(tx, unpaid.schoolId, q.id, operator);
      });
      const accepted = await change(unpaid.schoolId, unpaid.admin, (tx) =>
        acceptQuote(tx, unpaid.schoolId, quote.id, unpaid.admin),
      );
      await change(unpaid.schoolId, operator, (tx) =>
        recordPayment(
          tx,
          unpaid.schoolId,
          accepted.invoice.id,
          { amountMinor: 1000, receivedAt: new Date(), bankReference: "FT1" },
          operator,
        ),
      );
      await change(ending.schoolId, ending.admin, (tx) =>
        createChangeRequest(
          tx,
          ending.schoolId,
          { studentSeats: 40, note: "Two classes joined" },
          ending.admin,
        ),
      );

      const names = async (query: string) =>
        (
          (await (await asOperator("GET", `/api/platform/licenses${query}`)).json()) as {
            licenses: { schoolName: string }[];
          }
        ).licenses
          .map((l) => l.schoolName)
          .filter((n) => n.startsWith("Console"));

      expect(await names("?expiringWithinDays=30")).toEqual(["Console Ending"]);
      expect(await names("?seatsNearlyFull=0.9")).toEqual(["Console Ending"]);
      expect(await names("?unpaid=true")).toEqual(["Console Unpaid"]);
      expect(await names("?status=awaiting_payment")).toEqual(["Console Unpaid"]);
      expect((await names("")).sort()).toEqual([
        "Console Ending",
        "Console Healthy",
        "Console Unpaid",
      ]);

      const balance = (
        (await (await asOperator("GET", "/api/platform/licenses?unpaid=true")).json()) as {
          licenses: { schoolName: string; balanceMinor: number }[];
        }
      ).licenses.find((l) => l.schoolName === "Console Unpaid")!;
      expect(balance.balanceMinor).toBe(accepted.invoice.totalMinor - 1000);

      const inbox = (await (
        await asOperator("GET", "/api/platform/licenses/change-requests?status=open")
      ).json()) as { requests: { schoolName: string; studentSeats: number }[] };
      expect(inbox.requests).toEqual([
        expect.objectContaining({ schoolName: "Console Ending", studentSeats: 40 }),
      ]);

      // One school's overview: license, usage, payments, history.
      const overview = (await (
        await asOperator("GET", `/api/platform/schools/${unpaid.schoolId}/license-console`)
      ).json()) as {
        license: { status: string };
        usage: { feature: string }[];
        payments: { amountMinor: number }[];
        history: { targetTable: string }[];
      };
      expect(overview.license.status).toBe("awaiting_payment");
      expect(overview.usage.map((u) => u.feature)).toContain("ai_tutor");
      expect(overview.payments.map((p) => p.amountMinor)).toEqual([1000]);
      const tables = new Set(overview.history.map((h) => h.targetTable));
      for (const table of [
        "school_licenses",
        "license_quotes",
        "license_invoices",
        "license_payments",
      ]) {
        expect([table, tables.has(table)]).toEqual([table, true]);
      }

      const usage = (await (await asOperator("GET", "/api/platform/licenses/usage")).json()) as {
        schools: {
          schoolName: string;
          revenue: { currencyCode: string; thisMonthMinor: number }[];
        }[];
      };
      expect(usage.schools.find((s) => s.schoolName === "Console Unpaid")?.revenue).toEqual([
        expect.objectContaining({ currencyCode: "USD", thisMonthMinor: 1000 }),
      ]);
    },
  );
});

describe("permissions", () => {
  integrationTest("the console is SUPER_ADMIN only, writes need platform:manage", async () => {
    const f = await school("Console Perms");
    const asAdmin = (method: string, path: string, body?: unknown) =>
      authenticatedRequest(
        api,
        method,
        path,
        {
          schoolId: f.schoolId,
          userId: f.adminId,
          roles: [ROLES.ORG_ADMIN],
          channel: AUTH_CHANNELS.WEB,
        },
        body === undefined ? undefined : json(body),
      );
    for (const path of [
      "/api/platform/features",
      "/api/platform/tiers",
      "/api/platform/licenses",
      "/api/platform/licenses/change-requests",
      "/api/platform/licenses/usage",
      `/api/platform/schools/${f.schoolId}/license-console`,
    ]) {
      expect([path, (await asAdmin("GET", path)).status]).toEqual([path, 403]);
    }
    expect(
      (await asAdmin("PATCH", "/api/platform/features/ai_tutor", { status: "paused" })).status,
    ).toBe(403);
    const onApi = await authenticatedRequest(api, "GET", "/api/platform/features", {
      schoolId: hq,
      userId: operator.userId,
      roles: [ROLES.SUPER_ADMIN],
      channel: AUTH_CHANNELS.API,
    });
    expect(onApi.status).toBe(403);
  });
});
