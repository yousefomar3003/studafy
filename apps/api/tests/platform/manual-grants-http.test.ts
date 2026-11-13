/**
 * Manual grants (db/migrations/000211), end to end through HTTP: a super admin grants storage and
 * tiers by hand (a cash payment), the school's upload cap and the person's features follow, and
 * revoking or the end date takes them away again without deleting anything.
 *
 * Needs TEST_DATABASE_URL.
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
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

import type { TestApp, TestDatabase } from "../harness";
import type { TransactionSql } from "postgres";

const dbTest = test.skipIf(!integrationEnabled);
const DAY = 86_400_000;
const GIB = 1024 * 1024 * 1024;

let db: TestDatabase;
let api: TestApp;
let operator: { schoolId: string; userId: string };

interface Grant {
  id: string;
  kind: string;
  state: string;
  capBytes: number | null;
  userId: string | null;
  planCode: string | null;
  endsAt: string;
  amountMinor: number | null;
  currencyCode: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

interface Feature {
  key: string;
  active: boolean;
  source: string | null;
  sources: { source: string; periodEnd: string }[];
  periodEnd: string | null;
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 10 });
  await migrateDatabase(db.url);
  const created = createTestApp({ database: db.sql });
  await created.ready;
  api = created;

  const hq = (await createSchool(db.sql, { name: "Studafy HQ grants" })).id;
  const op = await createUser(db.sql, hq);
  await assignRole(db.sql, hq, op.id, "SUPER_ADMIN");
  operator = { schoolId: hq, userId: op.id };

  await asAdmin(null, async (tx) => {
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES ('student_grant_e2e', 'Student Plus', 'student', 31) RETURNING id::text AS id
    `;
    await tx`
      INSERT INTO app.plan_features (plan_id, feature_key, monthly_limit)
      VALUES (${student!.id}::uuid, 'ai_tutor', 300)
    `;
  });
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

async function asAdmin<T>(schoolId: string | null, fn: (tx: TransactionSql) => Promise<T>) {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    if (schoolId) await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

function call(
  who: { schoolId: string; userId: string },
  role: (typeof ROLES)[keyof typeof ROLES],
  method: string,
  path: string,
  body?: unknown,
) {
  return authenticatedRequest(
    api,
    method,
    path,
    { schoolId: who.schoolId, userId: who.userId, roles: [role], channel: AUTH_CHANNELS.WEB },
    body === undefined
      ? undefined
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } },
  );
}

const asOperator = (method: string, path: string, body?: unknown) =>
  call(operator, ROLES.SUPER_ADMIN, method, path, body);

async function school(name: string) {
  const schoolId = (await createSchool(db.sql, { name })).id;
  const admin = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, admin.id, "ORG_ADMIN");
  const student = await createStudent(db.sql, schoolId, { firstName: name, lastName: "Pupil" });
  await assignRole(db.sql, schoolId, student.userId, "STUDENT");
  const teacher = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, teacher.id, "INSTRUCTOR");
  return { schoolId, adminId: admin.id, studentUserId: student.userId, teacherId: teacher.id };
}

async function grant(schoolId: string, body: Record<string, unknown>) {
  const response = await asOperator("POST", `/api/platform/schools/${schoolId}/grants`, body);
  return { status: response.status, body: (await response.json()) as Grant };
}

async function storageCap(f: { schoolId: string; adminId: string }) {
  const response = await call(
    { schoolId: f.schoolId, userId: f.adminId },
    ROLES.ORG_ADMIN,
    "GET",
    "/api/subscriptions/storage/offer",
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    usage: { capBytes: number };
    granted: { capBytes: number; endsAt: string } | null;
  };
}

async function aiTutor(f: { schoolId: string; studentUserId: string }) {
  const response = await call(
    { schoolId: f.schoolId, userId: f.studentUserId },
    ROLES.STUDENT,
    "GET",
    "/api/me/features",
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { features: Feature[] };
  return body.features.find((feature) => feature.key === "ai_tutor")!;
}

/** USD collected on manual grants in the last 30 days, across every school in this database. */
async function manualUsd(): Promise<number> {
  const finance = (await (await asOperator("GET", "/api/platform/finance")).json()) as {
    manualPaymentsLast30Days: { currencyCode: string; collectedMinor: number }[];
  };
  return (
    finance.manualPaymentsLast30Days.find((row) => row.currencyCode === "USD")?.collectedMinor ?? 0
  );
}

async function auditRows(schoolId: string, grantId: string) {
  return asAdmin(
    schoolId,
    (tx) => tx<{ action: string }[]>`
      SELECT action::text AS action FROM app.audit_logs
      WHERE target_table = 'manual_grants' AND target_id = ${grantId}::uuid
      ORDER BY created_at
    `,
  );
}

describe("manual storage grants", () => {
  dbTest("the cap is the largest of included, add-on and grant; revoke drops it", async () => {
    const f = await school("Grant Storage");
    expect((await storageCap(f)).usage.capBytes).toBe(10 * GIB);
    const usdBefore = await manualUsd();

    const created = await grant(f.schoolId, {
      kind: "storage",
      capBytes: 100 * GIB,
      endsAt: new Date(Date.now() + 365 * DAY).toISOString(),
      reason: "Paid in cash at the office",
      amountMinor: 10000,
      currencyCode: "USD",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: "storage",
      state: "active",
      capBytes: 100 * GIB,
      amountMinor: 10000,
      currencyCode: "USD",
    });
    let offer = await storageCap(f);
    expect(offer.usage.capBytes).toBe(100 * GIB);
    expect(offer.granted?.capBytes).toBe(100 * GIB);

    // A smaller custom grant (a pilot's 20 GB) does not lower the cap; the largest counts.
    const small = await grant(f.schoolId, {
      kind: "storage",
      capBytes: 20 * GIB,
      endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
      reason: "Pilot",
    });
    expect(small.status).toBe(201);
    expect((await storageCap(f)).usage.capBytes).toBe(100 * GIB);

    // A live Stripe add-on bigger than the grant wins.
    await asAdmin(f.schoolId, async (tx) => {
      await tx`
        INSERT INTO app.storage_subscriptions (
          school_id, cap_bytes, status, current_period_start, current_period_end
        ) VALUES (
          ${f.schoolId}::uuid, ${1024 * GIB}, 'active', now() - interval '1 day',
          now() + interval '29 days'
        )
      `;
    });
    expect((await storageCap(f)).usage.capBytes).toBe(1024 * GIB);
    await asAdmin(f.schoolId, (tx) => tx`DELETE FROM app.storage_subscriptions`);

    const revoked = await asOperator(
      "POST",
      `/api/platform/schools/${f.schoolId}/grants/${created.body.id}/revoke`,
      { reason: "Entered for the wrong school" },
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      state: "revoked",
      revokeReason: "Entered for the wrong school",
    });
    offer = await storageCap(f);
    expect(offer.usage.capBytes).toBe(20 * GIB);
    expect(offer.granted?.capBytes).toBe(20 * GIB);

    // Revoking twice is refused; the row stays as history.
    const again = await asOperator(
      "POST",
      `/api/platform/schools/${f.schoolId}/grants/${created.body.id}/revoke`,
      { reason: "Again" },
    );
    expect(again.status).toBe(409);
    expect((await auditRows(f.schoolId, created.body.id)).map((r) => r.action)).toEqual([
      "insert",
      "update",
    ]);

    // The ended filter lists the revoked grant; active lists only the pilot.
    const active = (await (
      await asOperator("GET", `/api/platform/schools/${f.schoolId}/grants?filter=active`)
    ).json()) as { grants: Grant[] };
    expect(active.grants.map((g) => g.id)).toEqual([small.body.id]);
    const ended = (await (
      await asOperator("GET", `/api/platform/schools/${f.schoolId}/grants?filter=ended`)
    ).json()) as { grants: Grant[] };
    expect(ended.grants.map((g) => g.id)).toEqual([created.body.id]);

    // Finance counts the cash payment only while the grant stands.
    expect(await manualUsd()).toBe(usdBefore);
  });

  dbTest("an ended grant stops counting on its own", async () => {
    const f = await school("Grant Expiry");
    const usdBefore = await manualUsd();
    const created = await grant(f.schoolId, {
      kind: "storage",
      capBytes: 100 * GIB,
      endsAt: new Date(Date.now() + DAY).toISOString(),
      reason: "Trial month",
      amountMinor: 500,
      currencyCode: "USD",
    });
    expect(created.status).toBe(201);
    expect((await storageCap(f)).usage.capBytes).toBe(100 * GIB);

    expect(await manualUsd()).toBe(usdBefore + 500);

    // Move it into the past, as the clock would.
    await asAdmin(f.schoolId, async (tx) => {
      await tx`
        UPDATE app.manual_grants
        SET starts_at = now() - interval '40 days', ends_at = now() - interval '1 day'
        WHERE id = ${created.body.id}::uuid
      `;
    });
    const offer = await storageCap(f);
    expect(offer.usage.capBytes).toBe(10 * GIB);
    expect(offer.granted).toBeNull();
    const ended = (await (
      await asOperator("GET", `/api/platform/schools/${f.schoolId}/grants?filter=ended`)
    ).json()) as { grants: Grant[] };
    expect(ended.grants[0]).toMatchObject({ id: created.body.id, state: "ended" });
  });
});

describe("manual tier grants", () => {
  dbTest("a student's paid tier unlocks the feature and adds to a store subscription", async () => {
    const f = await school("Grant Tier");
    expect((await aiTutor(f)).active).toBe(false);

    const grantEnd = new Date(Date.now() + 180 * DAY);
    const created = await grant(f.schoolId, {
      kind: "tier",
      userId: f.studentUserId,
      planCode: "student_grant_e2e",
      endsAt: grantEnd.toISOString(),
      reason: "Six months paid in cash",
      amountMinor: 3000,
      currencyCode: "USD",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: "tier", planCode: "student_grant_e2e" });

    let feature = await aiTutor(f);
    expect(feature).toMatchObject({ active: true, source: "purchase" });
    expect(Date.parse(feature.periodEnd!)).toBe(grantEnd.getTime());

    // An App Store subscription ending earlier: both count, the later end is the one reported.
    await asAdmin(f.schoolId, async (tx) => {
      await tx`
        INSERT INTO app.user_subscriptions (
          school_id, user_id, plan_id, provider, status, current_period_start,
          current_period_end, provider_reference
        )
        SELECT ${f.schoolId}::uuid, ${f.studentUserId}::uuid, id, 'app_store', 'active',
               now() - interval '1 day', now() + interval '20 days', 'orig-tx-grant-e2e'
        FROM app.plans WHERE code = 'student_grant_e2e'
      `;
      // The store write path bumps the version; do the same so the entry is re-resolved.
      await tx`
        INSERT INTO app.entitlement_versions (school_id, subject_type, subject_id, version)
        VALUES (${f.schoolId}::uuid, 'user', ${f.studentUserId}::uuid, 100)
        ON CONFLICT ON CONSTRAINT pk_entitlement_versions
        DO UPDATE SET version = app.entitlement_versions.version + 100
      `;
    });
    feature = await aiTutor(f);
    expect(feature.active).toBe(true);
    expect(feature.sources).toHaveLength(2);
    expect(Date.parse(feature.periodEnd!)).toBe(grantEnd.getTime());

    // Revoking the grant leaves the store subscription covering.
    const revoked = await asOperator(
      "POST",
      `/api/platform/schools/${f.schoolId}/grants/${created.body.id}/revoke`,
      { reason: "Refunded" },
    );
    expect(revoked.status).toBe(200);
    feature = await aiTutor(f);
    expect(feature.active).toBe(true);
    expect(feature.sources).toHaveLength(1);
    expect(Date.parse(feature.periodEnd!)).toBeLessThan(grantEnd.getTime());
  });

  dbTest("revoking the only grant locks the feature at once", async () => {
    const f = await school("Grant Revoke");
    const created = await grant(f.schoolId, {
      kind: "tier",
      userId: f.studentUserId,
      planCode: "student_grant_e2e",
      endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
      reason: "One month",
    });
    expect(created.status).toBe(201);
    expect((await aiTutor(f)).active).toBe(true);
    const revoked = await asOperator(
      "POST",
      `/api/platform/schools/${f.schoolId}/grants/${created.body.id}/revoke`,
      { reason: "Mistake" },
    );
    expect(revoked.status).toBe(200);
    expect((await aiTutor(f)).active).toBe(false);
  });

  dbTest("a tier outside the person's audience is refused", async () => {
    const f = await school("Grant Audience");
    const refused = await grant(f.schoolId, {
      kind: "tier",
      userId: f.teacherId,
      planCode: "student_grant_e2e",
      endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
      reason: "Wrong person",
    });
    expect(refused.status).toBe(422);
    const unknown = await grant(f.schoolId, {
      kind: "tier",
      userId: f.studentUserId,
      planCode: "no_such_tier",
      endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
      reason: "Typo",
    });
    expect(unknown.status).toBe(422);
    const past = await grant(f.schoolId, {
      kind: "storage",
      capBytes: GIB,
      endsAt: new Date(Date.now() - DAY).toISOString(),
      reason: "Already over",
    });
    expect(past.status).toBe(400);
  });
});

describe("permissions", () => {
  dbTest("only platform:manage can grant; a school admin cannot even list", async () => {
    const f = await school("Grant Gate");
    const body = {
      kind: "storage",
      capBytes: 100 * GIB,
      endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
      reason: "Try",
    };
    const asSchoolAdmin = await call(
      { schoolId: f.schoolId, userId: f.adminId },
      ROLES.ORG_ADMIN,
      "POST",
      `/api/platform/schools/${f.schoolId}/grants`,
      body,
    );
    expect(asSchoolAdmin.status).toBe(403);
    const list = await call(
      { schoolId: f.schoolId, userId: f.adminId },
      ROLES.ORG_ADMIN,
      "GET",
      "/api/platform/grants",
    );
    expect(list.status).toBe(403);

    const all = (await (await asOperator("GET", "/api/platform/grants?filter=all")).json()) as {
      grants: Grant[];
    };
    expect(Array.isArray(all.grants)).toBe(true);
  });
});
