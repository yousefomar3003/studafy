/**
 * Session 6 of docs/billing/feature-licensing.md, end to end: the whole app (createApp, every
 * middleware) over a real migrated database and a real Redis entitlement cache, driven through HTTP
 * the way the web and mobile apps drive it -- the school admin assigns and frees seats through
 * /api/school/license/seats, the student reads GET /api/me/features and calls a gated AI route.
 *
 *   1. A student with a seat gets access with no purchase.
 *   2. Unassigning the seat removes access immediately (the cached entitlement is floored in the
 *      same request, and a userEntitlement.changed event is queued for the apps).
 *   3. A personal subscriber who gets a seat keeps the best of both, and their renewal is turned
 *      off (Tap: by Studafy; App Store: they are told how).
 *   4. A Family+ parent with a seat is covered at that school only.
 *
 * Needs TEST_DATABASE_URL and REDIS_URL: without Redis the AI routes are not mounted and the cache
 * would not be exercised, which is the point of scenario 2.
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import { createLicense, runLicenseChange, transitionLicense } from "../../src/modules/licensing";
import { createRedisClient } from "../../src/redis";
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
import type { RedisClient } from "../../src/redis";
import type { TestApp, TestDatabase } from "../harness";
import type { TransactionSql } from "postgres";

const redisUrl = process.env.REDIS_URL;
const e2eTest = test.skipIf(!integrationEnabled || !redisUrl);
const logger = createLogger({ destination: () => undefined });
const DAY = 86_400_000;

let db: TestDatabase;
let redis: RedisClient;
let api: TestApp;
let operator: LicenseActor;

interface Feature {
  key: string;
  active: boolean;
  source: string | null;
  sources: { source: string }[];
  limit: number | null;
  reason: string | null;
  schoolSeat: boolean;
  schoolOffers: boolean;
  renewalStop: { provider: string | null; action: string; status: string } | null;
}

beforeAll(async () => {
  if (!integrationEnabled || !redisUrl) return;
  db = await createTestDatabase({ maxConnections: 10 });
  await migrateDatabase(db.url);
  redis = createRedisClient({ url: redisUrl, logger });
  await redis.connect();
  const created = createTestApp({ database: db.sql, redis });
  await created.ready;
  api = created;

  const hq = (await createSchool(db.sql, { name: "Studafy HQ" })).id;
  const op = await createUser(db.sql, hq);
  await assignRole(db.sql, hq, op.id, "SUPER_ADMIN");
  operator = { kind: "platform", userId: op.id, homeSchoolId: hq };

  // A student tier with the AI tutor at 300 a month, and a Family+ parent tier.
  await asAdmin(null, async (tx) => {
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES ('student_gate_e2e', 'Student Plus', 'student', 21) RETURNING id::text AS id
    `;
    const [parent] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES ('family_gate_e2e', 'Family+', 'parent', 21) RETURNING id::text AS id
    `;
    await tx`
      INSERT INTO app.plan_features (plan_id, feature_key, monthly_limit) VALUES
        (${student!.id}::uuid, 'ai_tutor', 300),
        (${student!.id}::uuid, 'study_tools', 100),
        (${parent!.id}::uuid, 'family_plus', NULL)
    `;
  });
}, 180_000);

afterAll(async () => {
  await redis?.quit();
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

function deps(): LicensingDeps {
  return { database: db.sql, redis, logger, providers: { stripe: null, googlePlay: null } };
}

async function school(name: string, students: number) {
  const schoolId = (await createSchool(db.sql, { name })).id;
  const admin = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, admin.id, "ORG_ADMIN");
  const created = [];
  for (let i = 0; i < students; i += 1) {
    const student = await createStudent(db.sql, schoolId, { firstName: name, lastName: `${i}` });
    await assignRole(db.sql, schoolId, student.userId, "STUDENT");
    created.push(student);
  }
  return { schoolId, adminId: admin.id, students: created };
}

/** An active license with these seats, Family+ when there are parent seats. */
async function activeLicense(schoolId: string, seats: { student?: number; parent?: number }) {
  const plans = await asAdmin(
    null,
    (tx) => tx<{ code: string; id: string }[]>`
      SELECT code, id::text AS id FROM app.plans WHERE code IN ('student_gate_e2e', 'family_gate_e2e')
    `,
  );
  const plan = (code: string) => plans.find((p) => p.code === code)!.id;
  await runLicenseChange(deps(), schoolId, operator, async (tx) => {
    const license = await createLicense(
      tx,
      schoolId,
      {
        startsAt: new Date(Date.now() - DAY),
        endsAt: new Date(Date.now() + 300 * DAY),
        currencyCode: "USD",
        includeFamilyPlus: (seats.parent ?? 0) > 0,
        student: { planId: plan("student_gate_e2e"), seats: seats.student ?? 0 },
        ...(seats.parent
          ? { parent: { planId: plan("family_gate_e2e"), seats: seats.parent } }
          : {}),
      },
      operator,
    );
    return transitionLicense(tx, schoolId, license.id, "active", operator);
  });
}

function call(
  who: { schoolId: string; userId: string; role: string },
  method: string,
  path: string,
  body?: unknown,
) {
  return authenticatedRequest(
    api,
    method,
    path,
    {
      schoolId: who.schoolId,
      userId: who.userId,
      roles: [who.role as (typeof ROLES)[keyof typeof ROLES]],
      channel: AUTH_CHANNELS.WEB,
    },
    body === undefined
      ? undefined
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } },
  );
}

async function myFeatures(who: { schoolId: string; userId: string; role: string }) {
  const response = await call(who, "GET", "/api/me/features");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { schoolName: string; features: Feature[] };
  return {
    schoolName: body.schoolName,
    feature: (key: string) => body.features.find((f) => f.key === key)!,
  };
}

async function assignSeat(
  f: { schoolId: string; adminId: string },
  audience: string,
  userId: string,
) {
  const response = await call(
    { schoolId: f.schoolId, userId: f.adminId, role: ROLES.ORG_ADMIN },
    "POST",
    "/api/school/license/seats",
    { audience, userIds: [userId] },
  );
  expect(response.status).toBe(200);
  const result = (await response.json()) as { assigned: { seatId: string }[] };
  expect(result.assigned).toHaveLength(1);
  return result.assigned[0]!.seatId;
}

describe("feature gating end to end", () => {
  e2eTest("1-2. a seat gives access with no purchase; unassigning removes it at once", async () => {
    const f = await school("Gate Alpha", 1);
    await activeLicense(f.schoolId, { student: 5 });
    const student = { schoolId: f.schoolId, userId: f.students[0]!.userId, role: ROLES.STUDENT };

    // Before: not covered, but the school sells a seat that includes it -- ask, don't buy.
    const before = await myFeatures(student);
    expect(before.feature("ai_tutor")).toMatchObject({
      active: false,
      reason: "not_included",
      schoolSeat: false,
      schoolOffers: true,
    });
    expect((await call(student, "GET", "/api/ai/usage")).status).toBe(402);
    // The cache now holds the "no seat" verdict.
    expect(await redis.get(`ent:usr:${student.userId}`)).not.toBeNull();

    const seatId = await assignSeat(f, "student", student.userId);
    const covered = await myFeatures(student);
    expect(covered.schoolName).toBe("Gate Alpha");
    expect(covered.feature("ai_tutor")).toMatchObject({
      active: true,
      source: "school_license",
      limit: 300,
      schoolSeat: true,
      renewalStop: null,
    });
    expect(covered.feature("ai_tutor").sources.map((s) => s.source)).toEqual(["school_license"]);
    expect((await call(student, "GET", "/api/ai/usage")).status).toBe(200);
    // A seat holder is never sold the add-on: the offer says so and checkout refuses.
    const offer = (await (await call(student, "GET", "/api/subscriptions/ai/offer")).json()) as {
      students: { schoolSeat: boolean; schoolOffers: boolean }[];
    };
    expect(offer.students).toEqual([
      expect.objectContaining({ schoolSeat: true, schoolOffers: true }),
    ]);

    const freed = await call(
      { schoolId: f.schoolId, userId: f.adminId, role: ROLES.ORG_ADMIN },
      "DELETE",
      `/api/school/license/seats/${seatId}`,
    );
    expect(freed.status).toBe(200);
    // Immediately: no wait, no cache expiry.
    expect((await myFeatures(student)).feature("ai_tutor")).toMatchObject({
      active: false,
      schoolSeat: false,
    });
    expect((await call(student, "GET", "/api/ai/usage")).status).toBe(402);

    // The apps hear about it: a userEntitlement.changed event per change, for the realtime gateway
    // to deliver to this student's own room.
    const events = await asAdmin(
      f.schoolId,
      (tx) => tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM app.outbox_events
        WHERE school_id = ${f.schoolId}::uuid AND event_name = 'userEntitlement.changed'
          AND payload->>'userId' = ${student.userId}
      `,
    );
    expect(events[0]!.n).toBeGreaterThanOrEqual(2);
  });

  e2eTest(
    "3. a personal subscriber who gets a seat keeps the best of both; renewal is turned off",
    async () => {
      const f = await school("Gate Beta", 2);
      const [tap, apple] = f.students;
      // A Tap AI add-on (unlimited) for one student, an App Store one for the other. The AI add-on
      // is read through the school's own subscription row, so the school has one, live.
      await asAdmin(f.schoolId, async (tx) => {
        await tx`
          INSERT INTO app.subscriptions (school_id, plan_id, status, current_period_start, current_period_end)
          SELECT ${f.schoolId}::uuid, id, 'active', now() - interval '30 days', now() + interval '330 days'
          FROM app.plans WHERE code = 'free'
        `;
        await tx`
          INSERT INTO app.ai_subscriptions (
            school_id, student_id, status, current_period_start, current_period_end,
            tap_card_id, tap_payment_agreement_id
          ) VALUES (
            ${f.schoolId}::uuid, ${tap!.id}::uuid, 'active', now() - interval '5 days',
            now() + interval '25 days', 'card_x', ${`agr_${tap!.id.slice(0, 8)}`}
          )
        `;
        await tx`
          INSERT INTO app.user_subscriptions (
            school_id, user_id, plan_id, provider, status, current_period_start,
            current_period_end, provider_reference
          )
          SELECT ${f.schoolId}::uuid, ${apple!.userId}::uuid, id, 'app_store', 'active',
                 now() - interval '3 days', now() + interval '27 days', 'apple-orig-1'
          FROM app.plans WHERE code = 'ai_addon'
        `;
      });
      await activeLicense(f.schoolId, { student: 5 });

      for (const s of [tap!, apple!]) {
        await assignSeat(f, "student", s.userId);
      }

      const tapView = await myFeatures({
        schoolId: f.schoolId,
        userId: tap!.userId,
        role: ROLES.STUDENT,
      });
      // Best of both: the personal add-on's unlimited beats the seat's 300.
      expect(tapView.feature("ai_tutor")).toMatchObject({ active: true, limit: null });
      expect(
        tapView
          .feature("ai_tutor")
          .sources.map((s) => s.source)
          .sort(),
      ).toEqual(["purchase", "school_license"]);
      expect(tapView.feature("ai_tutor").renewalStop).toMatchObject({
        action: "cancel_at_period_end",
      });
      const [addon] = await asAdmin(
        f.schoolId,
        (tx) => tx<{ cancel_at_period_end: boolean }[]>`
          SELECT cancel_at_period_end FROM app.ai_subscriptions WHERE student_id = ${tap!.id}::uuid
        `,
      );
      expect(addon!.cancel_at_period_end).toBe(true);

      // Now a seat holder: a web checkout for them is refused, whatever the page showed.
      const checkout = await call(
        { schoolId: f.schoolId, userId: tap!.userId, role: ROLES.STUDENT },
        "POST",
        "/api/subscriptions/ai/checkout",
        {
          priceId: crypto.randomUUID(),
          studentId: tap!.id,
          successUrl: "https://studafy.test/ok",
          cancelUrl: "https://studafy.test/cancel",
        },
      );
      expect(checkout.status).toBe(409);
      expect(((await checkout.json()) as { code: string }).code).toBe(
        "AI_SUBSCRIPTION_COVERED_BY_SCHOOL",
      );

      const appleView = await myFeatures({
        schoolId: f.schoolId,
        userId: apple!.userId,
        role: ROLES.STUDENT,
      });
      expect(appleView.feature("ai_tutor").renewalStop).toMatchObject({
        provider: "app_store",
        action: "notify_user",
      });
    },
  );

  e2eTest("4. a Family+ parent with a seat is covered at that school only", async () => {
    const a = await school("Gate Gamma", 1);
    const b = await school("Gate Delta", 1);
    const email = `family-${crypto.randomUUID().slice(0, 6)}@two-schools.test`;
    const parentAt = async (s: typeof a, studentId: string) => {
      const parent = await createUser(db.sql, s.schoolId, { email });
      await assignRole(db.sql, s.schoolId, parent.id, "PARENT");
      await asAdmin(s.schoolId, async (tx) => {
        const [family] = await tx<{ id: string }[]>`
          INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
          VALUES (${s.schoolId}::uuid, 'Two schools', ${parent.id}::uuid) RETURNING id::text AS id
        `;
        await tx`
          INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
          VALUES (${s.schoolId}::uuid, ${family!.id}::uuid, ${parent.id}::uuid, ${studentId}::uuid, 'guardian')
        `;
      });
      return { schoolId: s.schoolId, userId: parent.id, role: ROLES.PARENT };
    };
    const atA = await parentAt(a, a.students[0]!.id);
    const atB = await parentAt(b, b.students[0]!.id);
    await activeLicense(a.schoolId, { student: 1, parent: 1 });
    await assignSeat(a, "parent", atA.userId);

    const viewA = await myFeatures(atA);
    expect(viewA.schoolName).toBe("Gate Gamma");
    expect(viewA.feature("family_plus")).toMatchObject({
      active: true,
      source: "school_license",
      schoolSeat: true,
    });
    // The same person at the other school: no seat there, and that school sells none.
    const viewB = await myFeatures(atB);
    expect(viewB.schoolName).toBe("Gate Delta");
    expect(viewB.feature("family_plus")).toMatchObject({
      active: false,
      schoolSeat: false,
      schoolOffers: false,
    });
  });
});
