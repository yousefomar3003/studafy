/**
 * Feature licensing against a real database (migration 000161, docs/billing/feature-licensing.md).
 *
 * What only Postgres can prove: the migration's catalog, the grants and RLS on the new tables, the
 * usage meter's conditional upsert under concurrency, and resolution from real rows -- including
 * that an AI add-on subscriber resolves to exactly the verdict the AI resolver gives.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTx } from "../../src/db/tenant-tx";
import {
  createFeatureService,
  createFeatureUsageMeter,
  readFeatureCatalog,
  syncFeatureCatalog,
} from "../../src/modules/features";
import { publishUserEntitlementChange } from "../../src/modules/subscriptions/entitlements/entitlement-change-publisher";
import {
  resolveAiEntitlement,
  resolveUserEntitlement,
} from "../../src/modules/subscriptions/entitlements/resolve";
import { createEntitlementService } from "../../src/modules/subscriptions/entitlements/service";
import { createTestDatabase, integrationEnabled, migrateDatabase } from "../harness";

import type { Logger } from "../../src/logger";
import type { TestDatabase } from "../harness";
import type { SubscriptionStatus } from "@studafy/constants";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);

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

let db: TestDatabase | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 12 });
  await migrateDatabase(db.url);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

interface Seeded {
  schoolId: string;
  userId: string;
  studentId: string;
  /** A second user in the same school with no student record (a teacher, say). */
  staffUserId: string;
}

async function seed(
  schoolStatus: SubscriptionStatus,
  aiStatus?: SubscriptionStatus,
): Promise<Seeded> {
  return db!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const slug = `feat-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Feature School ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    await tx`
      INSERT INTO app.subscriptions (school_id, plan_id, status, current_period_start, current_period_end)
      SELECT ${schoolId}::uuid, id, ${schoolStatus}::app.subscription_status,
             CURRENT_TIMESTAMP, '9999-12-31T00:00:00Z'
      FROM app.plans WHERE code = 'free'
    `;

    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${`s-${slug}@local`}, ${`s-${slug}@local`}, 'Student', 'active')
      RETURNING id
    `;
    const [staff] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${`t-${slug}@local`}, ${`t-${slug}@local`}, 'Teacher', 'active')
      RETURNING id
    `;
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${schoolId}::uuid, ${user!.id}::uuid, ${`ADM-${slug.slice(-6)}`}, 'Test', 'Student', 'enrolled')
      RETURNING id
    `;

    if (aiStatus) {
      await tx`
        INSERT INTO app.ai_subscriptions (
          school_id, student_id, status, current_period_start, current_period_end
        ) VALUES (
          ${schoolId}::uuid, ${student!.id}::uuid, ${aiStatus}::app.subscription_status,
          '2026-10-05T00:00:00Z', '2026-11-05T00:00:00Z'
        )
      `;
    }

    return { schoolId, userId: user!.id, studentId: student!.id, staffUserId: staff!.id };
  });
}

/** Run as the runtime role, the way the API's pool connects. */
async function asApp<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

function featureService() {
  const entitlements = createEntitlementService({
    database: db!.sql,
    redis: null,
    logger: silentLogger,
  });
  return createFeatureService({ database: db!.sql, entitlements, logger: silentLogger });
}

describe("migration 000161", () => {
  integrationTest(
    "registers the five launch features and makes ai_addon a student tier",
    async () => {
      const catalog = await readFeatureCatalog(db!.sql);

      expect(Object.keys(catalog.settings).sort()).toEqual([
        "ai_tutor",
        "auto_grading",
        "family_plus",
        "notebook",
        "study_tools",
      ]);
      expect(catalog.tiers.ai_addon).toMatchObject({
        code: "ai_addon",
        audience: "student",
        rank: 1,
        includesAllFeatures: false,
        limits: { ai_tutor: null, study_tools: null, notebook: null },
      });
      // School plans are not tiers.
      expect(catalog.tiers.free).toBeUndefined();
    },
  );

  integrationTest("the runtime role can read but not write the global catalog", async () => {
    const { schoolId } = await seed("active");

    await asApp(schoolId, async (tx) => {
      const rows = await tx`SELECT key FROM app.features`;
      expect(rows.length).toBeGreaterThanOrEqual(5);
    });

    await expect(
      asApp(schoolId, (tx) => tx`UPDATE app.features SET status = 'paused' WHERE key = 'ai_tutor'`),
    ).rejects.toThrow(/permission denied/);
    await expect(asApp(schoolId, (tx) => tx`DELETE FROM app.plan_features`)).rejects.toThrow(
      /permission denied/,
    );
  });

  integrationTest("tier columns are all-or-nothing", async () => {
    await expect(
      db!.sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`
          INSERT INTO app.plans (code, display_name, audience) VALUES ('half_tier', 'Half', 'student')
        `;
      }),
    ).rejects.toThrow(/ck_plans_tier/);
  });
});

describe("syncFeatureCatalog", () => {
  integrationTest("is insert-only: an edited display name and status survive a sync", async () => {
    await db!.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`UPDATE app.features SET display_name = 'Tutor', status = 'hidden' WHERE key = 'ai_tutor'`;
      await tx`DELETE FROM app.features WHERE key = 'family_plus'`;
    });

    const inserted = await syncFeatureCatalog(db!.sql);
    const rows = await db!.sql<{ key: string; display_name: string; status: string }[]>`
      SELECT key, display_name, status FROM app.features WHERE key IN ('ai_tutor', 'family_plus')
      ORDER BY key
    `;

    expect(inserted).toEqual(["family_plus"]);
    expect([...rows]).toEqual([
      { key: "ai_tutor", display_name: "Tutor", status: "hidden" },
      { key: "family_plus", display_name: "Family plus", status: "active" },
    ]);
    expect(await syncFeatureCatalog(db!.sql)).toEqual([]);

    await db!.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`UPDATE app.features SET display_name = 'AI tutor', status = 'active' WHERE key = 'ai_tutor'`;
      await tx`UPDATE app.features SET display_name = 'Family+' WHERE key = 'family_plus'`;
    });
  });
});

describe("tenant tables", () => {
  integrationTest(
    "user_subscriptions and feature_usage_meters are isolated per school",
    async () => {
      const a = await seed("active");
      const b = await seed("active");

      await asApp(a.schoolId, async (tx) => {
        await tx`
        INSERT INTO app.user_subscriptions (
          school_id, user_id, plan_id, provider, status, current_period_start, current_period_end,
          provider_reference
        )
        SELECT ${a.schoolId}::uuid, ${a.userId}::uuid, id, 'stripe', 'active',
               '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', 'sub_a'
        FROM app.plans WHERE code = 'ai_addon'
      `;
      });
      await createFeatureUsageMeter({ database: db!.sql }).consume({
        schoolId: a.schoolId,
        userId: a.userId,
        key: "ai_tutor",
        amount: 1,
        limit: null,
      });

      await asApp(b.schoolId, async (tx) => {
        expect(await tx`SELECT id FROM app.user_subscriptions`).toHaveLength(0);
        expect(await tx`SELECT user_id FROM app.feature_usage_meters`).toHaveLength(0);
      });
      await asApp(a.schoolId, async (tx) => {
        expect(await tx`SELECT id FROM app.user_subscriptions`).toHaveLength(1);
        expect(await tx`SELECT user_id FROM app.feature_usage_meters`).toHaveLength(1);
      });

      // A row for another school's user is refused by the composite foreign key and RLS.
      await expect(
        asApp(
          a.schoolId,
          (tx) => tx`
        INSERT INTO app.feature_usage_meters (school_id, user_id, feature_key, period_start, used)
        VALUES (${a.schoolId}::uuid, ${b.userId}::uuid, 'ai_tutor', '2026-10-01', 1)
      `,
        ),
      ).rejects.toThrow();
      // No DELETE grant: a subscription ends by status, a meter is a ledger.
      await expect(
        asApp(a.schoolId, (tx) => tx`DELETE FROM app.user_subscriptions`),
      ).rejects.toThrow(/permission denied/);
    },
  );

  integrationTest("a usage period must start on the 1st", async () => {
    const { schoolId, userId } = await seed("active");

    await expect(
      asApp(
        schoolId,
        (tx) => tx`
        INSERT INTO app.feature_usage_meters (school_id, user_id, feature_key, period_start, used)
        VALUES (${schoolId}::uuid, ${userId}::uuid, 'ai_tutor', '2026-10-02', 1)
      `,
      ),
    ).rejects.toThrow(/ck_feature_usage_meters_period_start/);
  });
});

describe("feature usage meter", () => {
  integrationTest("concurrent consumes never pass the limit", async () => {
    const { schoolId, userId } = await seed("active");
    const meter = createFeatureUsageMeter({ database: db!.sql });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        meter.consume({ schoolId, userId, key: "study_tools", amount: 1, limit: 7 }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(7);
    expect((await meter.read(schoolId, userId)).study_tools).toBe(7);
  });

  integrationTest("a first use bigger than the limit is refused and writes nothing", async () => {
    const { schoolId, userId } = await seed("active");
    const meter = createFeatureUsageMeter({ database: db!.sql });

    const result = await meter.consume({ schoolId, userId, key: "notebook", amount: 5, limit: 3 });

    expect(result).toMatchObject({ ok: false, used: 0 });
    expect((await meter.read(schoolId, userId)).notebook).toBeUndefined();
  });

  integrationTest("refund gives units back and never goes below zero", async () => {
    const { schoolId, userId } = await seed("active");
    const meter = createFeatureUsageMeter({ database: db!.sql });

    const first = await meter.consume({
      schoolId,
      userId,
      key: "ai_tutor",
      amount: 2,
      limit: null,
    });
    await meter.refund({
      schoolId,
      userId,
      key: "ai_tutor",
      amount: 1,
      periodStart: first.periodStart,
    });
    expect((await meter.read(schoolId, userId)).ai_tutor).toBe(1);
    await meter.refund({
      schoolId,
      userId,
      key: "ai_tutor",
      amount: 5,
      periodStart: first.periodStart,
    });
    expect((await meter.read(schoolId, userId)).ai_tutor).toBe(0);
  });
});

describe("resolution from real rows", () => {
  const LIVE: [SubscriptionStatus, boolean][] = [
    ["trialing", true],
    ["active", true],
    ["past_due", true],
    ["grace_period", true],
    ["canceled", false],
    ["expired", false],
    ["paused", false],
  ];

  for (const [status, live] of LIVE) {
    integrationTest(
      `an AI add-on in ${status} matches the AI resolver (active=${String(live)})`,
      async () => {
        const { schoolId, studentId, userId } = await seed("active", status);

        const { ai } = await withTenantTx(db!.sql, { schoolId }, (tx) =>
          resolveAiEntitlement(tx, schoolId, studentId),
        );
        const fromStudent = await featureService().resolve(schoolId, { studentId });
        const fromUser = await featureService().resolve(schoolId, { userId });

        expect(ai.userId).toBe(userId);
        for (const resolved of [fromStudent, fromUser]) {
          expect(resolved.userId).toBe(userId);
          expect(resolved.studentId).toBe(studentId);
          for (const key of ["ai_tutor", "study_tools", "notebook"] as const) {
            expect(resolved.features[key].active).toBe(ai.active);
            if (live) {
              expect(resolved.features[key]).toMatchObject({
                source: status === "trialing" ? "trial" : "purchase",
                limit: null,
                periodStart: ai.currentPeriodStart,
                periodEnd: ai.currentPeriodEnd,
              });
            } else {
              expect(resolved.features[key].reason).toBe("expired");
            }
          }
          expect(resolved.features.auto_grading.active).toBe(false);
        }
      },
    );
  }

  integrationTest("an inactive school turns an active add-on off", async () => {
    const { schoolId, studentId } = await seed("canceled", "active");

    const resolved = await featureService().resolve(schoolId, { studentId });

    expect(resolved.features.ai_tutor).toMatchObject({ active: false, reason: "school_inactive" });
  });

  integrationTest(
    "a personal subscription and the add-on combine: latest end, every source",
    async () => {
      const { schoolId, userId } = await seed("active", "active");
      await db!.sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
        await tx`
        INSERT INTO app.plans (code, display_name, audience, rank, is_active)
        VALUES (${`tier_${schoolId.slice(0, 8)}`}, 'Student Plus', 'student', 2, false)
      `;
        await tx`
        INSERT INTO app.plan_features (plan_id, feature_key, monthly_limit)
        SELECT id, 'notebook', 40 FROM app.plans WHERE code = ${`tier_${schoolId.slice(0, 8)}`}
      `;
        await tx`
        INSERT INTO app.user_subscriptions (
          school_id, user_id, plan_id, provider, status, current_period_start, current_period_end,
          provider_reference
        )
        SELECT ${schoolId}::uuid, ${userId}::uuid, id, 'app_store', 'active',
               '2026-10-01T00:00:00Z', '2027-10-01T00:00:00Z', 'orig-tx-1'
        FROM app.plans WHERE code = ${`tier_${schoolId.slice(0, 8)}`}
      `;
      });

      const features = await featureService().resolveFeatures(schoolId, userId);

      // Notebook: unlimited from the add-on beats 40 from the tier; the tier's end is later.
      expect(features.notebook).toMatchObject({
        active: true,
        limit: null,
        periodEnd: "2027-10-01T00:00:00.000Z",
      });
      expect(features.notebook.sources.map((s) => s.tierCode)).toEqual([
        `tier_${schoolId.slice(0, 8)}`,
        "ai_addon",
      ]);
      // ai_tutor comes from the add-on alone.
      expect(features.ai_tutor.sources.map((s) => s.tierCode)).toEqual(["ai_addon"]);
    },
  );

  integrationTest("a non-student resolves with no student record and no AI grant", async () => {
    const { schoolId, staffUserId } = await seed("active");

    const user = await withTenantTx(db!.sql, { schoolId }, (tx) =>
      resolveUserEntitlement(tx, schoolId, staffUserId),
    );
    const resolved = await featureService().resolve(schoolId, { userId: staffUserId });

    expect(user).toMatchObject({ studentId: null, subscriptions: [], version: 1 });
    expect(resolved.features.ai_tutor).toMatchObject({ active: false, reason: "not_included" });
  });

  integrationTest(
    "publishUserEntitlementChange bumps the user version and emits the event",
    async () => {
      const { schoolId, userId } = await seed("active");

      const version = await withTenantTx(db!.sql, { schoolId }, (tx) =>
        publishUserEntitlementChange(tx, { schoolId, userId }),
      );
      const user = await withTenantTx(db!.sql, { schoolId }, (tx) =>
        resolveUserEntitlement(tx, schoolId, userId),
      );
      const [event] = await withTenantTx(
        db!.sql,
        { schoolId },
        (tx) => tx<
          { event_name: string; payload: { userId: string; entitlementsVersion: number } }[]
        >`
        SELECT event_name, payload FROM app.outbox_events
        WHERE event_name = 'userEntitlement.changed'
        ORDER BY id DESC LIMIT 1
      `,
      );

      expect(version).toBe(2);
      expect(user.version).toBe(2);
      expect(event).toMatchObject({ payload: { userId, entitlementsVersion: 2 } });
    },
  );
});
