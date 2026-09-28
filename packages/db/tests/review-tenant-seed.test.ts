import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { assertReviewSeedAllowed, SeedSafetyError } from "../../../db/seeds/guard";
import {
  REVIEW_LOGIN_PROVIDER,
  REVIEW_LOGINS,
  REVIEW_PERSONAS,
  reviewLoginIdentity,
} from "../../../db/seeds/review-credentials";
import { seedReviewTenant } from "../../../db/seeds/review-tenant";
import { seedDemoTenant } from "../../../db/seeds/seed";
import { DEMO_TENANT, REVIEW_TENANT } from "../../../db/seeds/tenants";
import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

// Same gating as seed.test.ts: the full seed needs a disposable database and a longer budget than the
// main suite's per-test timeout, so it runs only in the dedicated SEED_INTEGRATION step.
const integrationTest = test.skipIf(!integrationEnabled || !process.env.SEED_INTEGRATION);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

// Deliberately a try/catch, like global-tables.test.ts: `await expect(...).rejects` can hang on
// postgres.js thenable queries in bun:test (oven-sh/bun#31462, #19130).
async function expectViolation(query: PromiseLike<unknown>, constraint: string): Promise<void> {
  let message = "";
  try {
    await query;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain(constraint);
}

const CONFIRM = { REVIEW_TENANT_SEED_CONFIRM: REVIEW_TENANT.slug };

describe("review seed guard", () => {
  test("refuses without an explicit confirmation", () => {
    expect(() => assertReviewSeedAllowed({}, REVIEW_TENANT.slug)).toThrow(SeedSafetyError);
  });

  test("refuses a confirmation naming another tenant", () => {
    expect(() =>
      assertReviewSeedAllowed({ REVIEW_TENANT_SEED_CONFIRM: DEMO_TENANT.slug }, REVIEW_TENANT.slug),
    ).toThrow(SeedSafetyError);
  });

  test("allows the confirmed slug, including in production", () => {
    expect(() =>
      assertReviewSeedAllowed(
        { ...CONFIRM, NODE_ENV: "production" } as typeof CONFIRM,
        REVIEW_TENANT.slug,
      ),
    ).not.toThrow();
  });
});

describe("review tenant profile", () => {
  test("only the review profile is flagged, non-billable, and free of local fixtures", () => {
    expect(REVIEW_TENANT.isReviewTenant).toBe(true);
    expect(REVIEW_TENANT.plan.isActive).toBe(false);
    expect(REVIEW_TENANT.plan.monthlyAmountMinor).toBeNull();
    expect(REVIEW_TENANT.localFixtures).toBe(false);
    expect(DEMO_TENANT.isReviewTenant).toBe(false);
  });

  test("has no platform-wide role and gives parents the PARENT role", () => {
    expect(REVIEW_PERSONAS.some((persona) => persona.role === "SUPER_ADMIN")).toBe(false);
    const parents = REVIEW_PERSONAS.filter((persona) => persona.group === "parent");
    expect(parents.length).toBeGreaterThan(0);
    expect(parents.every((persona) => persona.role === "PARENT")).toBe(true);
  });

  test("exactly the four documented accounts can log in, one per role", () => {
    const withLogin = REVIEW_PERSONAS.filter((persona) => reviewLoginIdentity(persona) !== null);
    expect(withLogin.map((persona) => persona.email).sort()).toEqual(
      REVIEW_LOGINS.map((login) => login.email).sort(),
    );
    expect(new Set(REVIEW_LOGINS.map((login) => login.role)).size).toBe(4);
    for (const persona of withLogin) {
      expect(reviewLoginIdentity(persona)).toEqual({
        provider: REVIEW_LOGIN_PROVIDER,
        subject: persona.email.toLowerCase(),
      });
    }
  });

  test("every roster email is unique and on the reserved review domain", () => {
    const emails = REVIEW_PERSONAS.map((persona) => persona.email);
    expect(new Set(emails).size).toBe(emails.length);
    expect(emails.every((email) => email.endsWith("@review.studafy.test"))).toBe(true);
  });
});

integrationTest(
  "provisions an isolated, non-billable review tenant next to the demo tenant",
  async () => {
    const database = await testDatabase();
    try {
      await runMigrationCommand("migrate", {
        env: runnerEnv(database.url, repositoryMigrations),
        log: () => undefined,
      });
      const env = { DATABASE_URL: database.url, DATABASE_SSL_MODE: "disable" };

      expect((await seedDemoTenant({ env })).seeded).toBe(true);
      await expect(seedReviewTenant({ env })).rejects.toThrow(SeedSafetyError);

      const result = await seedReviewTenant({ env: { ...env, ...CONFIRM } });
      expect(result.seeded).toBe(true);
      const schoolId = result.schoolId!;
      const sql = database.sql;

      const flags = await sql<{ slug: string; is_review_tenant: boolean }[]>`
        SELECT slug, is_review_tenant FROM app.schools ORDER BY slug
      `;
      expect([...flags]).toEqual([
        { slug: DEMO_TENANT.slug, is_review_tenant: false },
        { slug: REVIEW_TENANT.slug, is_review_tenant: true },
      ]);

      // The four logins resolve to the four roles, all under the review provider and nothing else.
      const logins = await sql<{ provider: string; subject: string; role: string }[]>`
        SELECT i.provider, i.subject, r.role::text AS role
        FROM app.oauth_identities i
        JOIN app.user_roles r ON r.user_id = i.user_id AND r.school_id = i.school_id
        WHERE i.school_id = ${schoolId}::uuid
        ORDER BY r.role::text
      `;
      expect(logins.map((row) => row.role)).toEqual([
        "INSTRUCTOR",
        "ORG_ADMIN",
        "PARENT",
        "STUDENT",
      ]);
      expect(logins.every((row) => row.provider === REVIEW_LOGIN_PROVIDER)).toBe(true);

      const [{ count: superAdmins }] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.user_roles
        WHERE school_id = ${schoolId}::uuid AND role = 'SUPER_ADMIN'
      `;
      expect(superAdmins).toBe(0);

      // The parent login is linked to the student login.
      const parentEmail = REVIEW_LOGINS.find((login) => login.role === "Parent")!.email;
      const studentEmail = REVIEW_LOGINS.find((login) => login.role === "Student")!.email;
      const [{ count: linked }] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM app.parent_child_links l
        JOIN app.users p ON p.id = l.parent_user_id
        JOIN app.students s ON s.id = l.student_id
        JOIN app.users su ON su.id = s.user_id
        WHERE l.school_id = ${schoolId}::uuid
          AND p.normalized_email = ${parentEmail}
          AND su.normalized_email = ${studentEmail}
      `;
      expect(linked).toBe(1);

      // Demo data renders from real rows, and nothing a deployed worker would act on was written.
      const counts = Object.fromEntries(
        (result.counts ?? []).map((row) => [row.table_name, row.row_count]),
      );
      for (const table of ["classes", "enrollments", "assignments", "grades", "materials"]) {
        expect(counts[table]).toBeGreaterThan(0);
      }
      expect(counts.user_devices).toBe(0);
      expect(counts.outbox_events).toBe(0);

      // Every tenant address is suppressed before the email dispatcher can reach SES.
      const [{ count: unsuppressed }] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.users u
        WHERE u.school_id = ${schoolId}::uuid
          AND NOT EXISTS (
            SELECT 1 FROM app.email_suppressions s
            WHERE s.address = u.normalized_email AND s.reason = 'review_tenant'
          )
      `;
      expect(unsuppressed).toBe(0);

      // Its plan is never sellable.
      const [plan] = await sql<{ is_active: boolean; prices: number }[]>`
        SELECT p.is_active, (SELECT count(*)::int FROM app.plan_prices pp WHERE pp.plan_id = p.id) AS prices
        FROM app.plans p WHERE p.code = ${REVIEW_TENANT.plan.code}
      `;
      expect(plan).toEqual({ is_active: false, prices: 0 });

      // Migration 000115 invariants: no billing customer, and no second review tenant.
      await expectViolation(
        sql`UPDATE app.schools SET stripe_customer_id = 'cus_review' WHERE id = ${schoolId}::uuid`,
        "ck_schools_review_tenant_unbillable",
      );
      await expectViolation(
        sql`UPDATE app.schools SET tap_customer_id = 'cus_review' WHERE id = ${schoolId}::uuid`,
        "ck_schools_review_tenant_unbillable",
      );
      await expectViolation(
        sql`UPDATE app.schools SET is_review_tenant = true WHERE slug = ${DEMO_TENANT.slug}`,
        "uq_schools_review_tenant",
      );

      // Re-running is a clean no-op, so a deploy pipeline can run it every release.
      expect((await seedReviewTenant({ env: { ...env, ...CONFIRM } })).seeded).toBe(false);
    } finally {
      await database.cleanup();
    }
  },
  90_000,
);
