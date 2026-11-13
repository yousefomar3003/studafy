/**
 * Entitlement resolution against a real database (ST-133).
 *
 * The headline assertion is the join: a student's AI add-on can read `active` in its own row and
 * still resolve to inactive because the school is not live. The rows are written directly rather than
 * driven through the billing cascade, so nothing but the resolver's own SQL can be producing the
 * answer — a cascade would move the `ai_subscriptions` row too and mask the very case under test.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTx } from "../../src/db/tenant-tx";
import {
  resolveAiEntitlement,
  resolveSchoolEntitlement,
} from "../../src/modules/subscriptions/entitlements/resolve";
import { createTestDatabase, integrationEnabled, migrateDatabase } from "../harness";

import type { TestDatabase } from "../harness";
import type { SubscriptionStatus } from "@studafy/constants";

const integrationTest = test.skipIf(!integrationEnabled);

let db: TestDatabase | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

interface Seeded {
  schoolId: string;
  studentId: string;
}

/**
 * A school with a subscription in `status`, and optionally a student with an AI add-on in `aiStatus`.
 *
 * Seeded as `studafy_admin` with the tenant GUC armed, the way the billing fixture and the harness
 * factories both do — these tables are RLS-forced, so a seed without the GUC inserts nothing.
 */
async function seed(status: SubscriptionStatus, aiStatus?: SubscriptionStatus): Promise<Seeded> {
  return db!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;

    const slug = `ent-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Ent School ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const schoolId = school!.id;

    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, is_active)
      VALUES (${`plan_${slug.replaceAll("-", "_")}`}, 'Entitlement Test Plan', true)
      RETURNING id
    `;

    await tx`
      INSERT INTO app.subscriptions (
        school_id, plan_id, status, current_period_start, current_period_end, student_cap
      ) VALUES (
        ${schoolId}::uuid, ${plan!.id}::uuid, ${status}::app.subscription_status,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days', 250
      )
    `;

    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (
        ${schoolId}::uuid, ${`s-${slug}@local`}, ${`s-${slug}@local`}, 'Test Student', 'active'
      )
      RETURNING id
    `;

    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (
        ${schoolId}::uuid, ${user!.id}::uuid, ${`ADM-${slug.slice(-6)}`}, 'Test', 'Student', 'enrolled'
      )
      RETURNING id
    `;

    if (aiStatus) {
      await tx`
        INSERT INTO app.ai_subscriptions (
          school_id, student_id, status, current_period_start, current_period_end
        ) VALUES (
          ${schoolId}::uuid, ${student!.id}::uuid, ${aiStatus}::app.subscription_status,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days'
        )
      `;
    }

    return { schoolId, studentId: student!.id };
  });
}

describe("school entitlement", () => {
  // LIVE_STATUSES vs TERMINAL_STATUSES, asserted through the resolver rather than restated.
  const cases: [SubscriptionStatus, boolean][] = [
    ["trialing", true],
    ["active", true],
    ["past_due", true],
    ["grace_period", true],
    ["canceled", false],
    ["expired", false],
    ["closed", false],
  ];

  for (const [status, expected] of cases) {
    integrationTest(`${status} resolves active=${String(expected)}`, async () => {
      const { schoolId } = await seed(status);

      const entitlement = await withTenantTx(db!.sql, { schoolId }, (tx) =>
        resolveSchoolEntitlement(tx, schoolId),
      );

      expect(entitlement.status).toBe(status);
      expect(entitlement.active).toBe(expected);
    });
  }

  integrationTest("carries the plan-level quota ceiling and plan code", async () => {
    const { schoolId } = await seed("active");

    const entitlement = await withTenantTx(db!.sql, { schoolId }, (tx) =>
      resolveSchoolEntitlement(tx, schoolId),
    );

    // The seeded student_cap, not the column default — proving it is read rather than assumed.
    expect(entitlement.quotas.studentCap).toBe(250);
    expect(entitlement.planCode).toMatch(/^plan_ent_/);
    expect(entitlement.currentPeriodEnd).toBeTruthy();
  });

  // The provisioning window: school row exists, subscription row does not yet.
  integrationTest(
    "a school with no subscription row resolves to trialing at version 1",
    async () => {
      const schoolId = await db!.sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        const [reference] = await tx<{ country: string; currency: string }[]>`
        SELECT
          (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
          (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
      `;
        const slug = `bare-${crypto.randomUUID().slice(0, 8)}`;
        const [school] = await tx<{ id: string }[]>`
        INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
        VALUES (
          ${slug}, ${`Bare ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
          ${reference!.country}, ${reference!.currency}
        )
        RETURNING id
      `;
        return school!.id;
      });

      const entitlement = await withTenantTx(db!.sql, { schoolId }, (tx) =>
        resolveSchoolEntitlement(tx, schoolId),
      );

      expect(entitlement.status).toBe("trialing");
      expect(entitlement.active).toBe(true);
      expect(entitlement.version).toBe(1);
      expect(entitlement.quotas.studentCap).toBe(50);
    },
  );
});

describe("ai entitlement", () => {
  integrationTest("active school plus active add-on resolves active", async () => {
    const { schoolId, studentId } = await seed("active", "active");

    const { ai } = await withTenantTx(db!.sql, { schoolId }, (tx) =>
      resolveAiEntitlement(tx, schoolId, studentId),
    );

    expect(ai.active).toBe(true);
    expect(ai.status).toBe("active");
  });

  // The acceptance criterion. The ai_subscriptions row is untouched and still reads 'active'; only
  // the school moved. A resolver that looked at the two independently would answer true here.
  integrationTest(
    "an inactive school forces AI inactive despite an active add-on row",
    async () => {
      const { schoolId, studentId } = await seed("canceled", "active");

      const { ai, school } = await withTenantTx(db!.sql, { schoolId }, (tx) =>
        resolveAiEntitlement(tx, schoolId, studentId),
      );

      expect(school.active).toBe(false);
      // The row itself is still 'active' — the verdict is not.
      expect(ai.status).toBe("active");
      expect(ai.active).toBe(false);
    },
  );

  integrationTest("every non-live school status forces AI inactive", async () => {
    for (const status of ["canceled", "expired", "closed"] as SubscriptionStatus[]) {
      const { schoolId, studentId } = await seed(status, "active");

      const { ai } = await withTenantTx(db!.sql, { schoolId }, (tx) =>
        resolveAiEntitlement(tx, schoolId, studentId),
      );

      expect(ai.active).toBe(false);
    }
  });

  integrationTest("a student with no add-on resolves inactive, not absent", async () => {
    const { schoolId, studentId } = await seed("active");

    const { ai } = await withTenantTx(db!.sql, { schoolId }, (tx) =>
      resolveAiEntitlement(tx, schoolId, studentId),
    );

    expect(ai.status).toBeNull();
    expect(ai.active).toBe(false);
  });

  // The guard that lets a non-school-prefixed AI key survive a school-level change.
  integrationTest("the AI verdict carries the school version it was computed against", async () => {
    const { schoolId, studentId } = await seed("active", "active");

    const { ai, school } = await withTenantTx(db!.sql, { schoolId }, (tx) =>
      resolveAiEntitlement(tx, schoolId, studentId),
    );

    expect(ai.schoolVersion).toBe(school.version);
  });
});
