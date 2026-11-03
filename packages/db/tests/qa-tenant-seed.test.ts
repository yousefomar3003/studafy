import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { assertQaSeedAllowed, SeedSafetyError } from "../../../db/seeds/guard";
import {
  QA_LOGIN_PROVIDER,
  QA_LOGINS,
  QA_SCHOOLS,
  QA_SEED_CONFIRMATION,
} from "../../../db/seeds/qa-credentials";
import { seedQaTenant } from "../../../db/seeds/qa-tenant";
import { seedReviewTenant } from "../../../db/seeds/review-tenant";
import { DEMO_TENANT, QA_TENANTS, REVIEW_TENANT } from "../../../db/seeds/tenants";
import { QA_DIR, renderQaFiles } from "../../../qa/generate";
import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { MockRole } from "../../../db/seeds/mock-credentials";
import type { MigrationConfig } from "../src/config";

// Same gating as review-tenant-seed.test.ts: full seeds run only in the SEED_INTEGRATION step.
const integrationTest = test.skipIf(!integrationEnabled || !process.env.SEED_INTEGRATION);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

const CONFIRM = { QA_TENANT_SEED_CONFIRM: QA_SEED_CONFIRMATION };
const SCHOOL_ROLES: MockRole[] = [
  "ATTENDANCE_OFFICER",
  "FINANCE",
  "INSTRUCTOR",
  "ORG_ADMIN",
  "PARENT",
  "PRINCIPAL",
  "STUDENT",
];

function hostConfig(host: string): MigrationConfig {
  return { url: `postgresql://u:p@${host}:5432/postgres` } as MigrationConfig;
}

describe("QA seed guard", () => {
  const allow = (env: Record<string, string>, host: string) => () =>
    assertQaSeedAllowed(env, hostConfig(host), QA_SEED_CONFIRMATION);

  test("refuses without an explicit confirmation", () => {
    expect(allow({}, "localhost")).toThrow(SeedSafetyError);
    expect(allow({ QA_TENANT_SEED_CONFIRM: REVIEW_TENANT.slug }, "localhost")).toThrow(
      SeedSafetyError,
    );
  });

  test("allows a local or staging-shaped host, including with NODE_ENV=production", () => {
    expect(allow(CONFIRM, "127.0.0.1")).not.toThrow();
    expect(
      allow(
        { ...CONFIRM, NODE_ENV: "production", APP_ENV: "staging" },
        "studafy-staging-postgres.abc123.me-central-1.rds.amazonaws.com",
      ),
    ).not.toThrow();
  });

  test("refuses APP_ENV=production even on an allowed host", () => {
    expect(allow({ ...CONFIRM, APP_ENV: "production" }, "localhost")).toThrow(/production/);
  });

  test("refuses production-shaped and unrecognized hosts", () => {
    expect(allow(CONFIRM, "studafy-prod-postgres.abc123.me-central-1.rds.amazonaws.com")).toThrow(
      /production-shaped/,
    );
    expect(allow(CONFIRM, "db.production.internal")).toThrow(/production-shaped/);
    expect(allow(CONFIRM, "shared-db.example.com")).toThrow(/local or staging-shaped/);
  });
});

describe("QA tenant profiles", () => {
  test("three schools, all QA tenants, none a review tenant, none with local fixtures", () => {
    expect(QA_TENANTS.map((tenant) => tenant.slug)).toEqual(
      QA_SCHOOLS.map((school) => school.slug),
    );
    for (const tenant of QA_TENANTS) {
      expect(tenant.isQaTenant).toBe(true);
      expect(tenant.isReviewTenant).toBe(false);
      expect(tenant.localFixtures).toBe(false);
      expect(tenant.plan.isActive).toBe(false);
    }
    expect(DEMO_TENANT.isQaTenant).toBe(false);
    expect(REVIEW_TENANT.isQaTenant).toBe(false);
  });

  test("SUPER_ADMIN lives only in the platform school; both schools hold every school role", () => {
    const [platform, schoolA, schoolB] = QA_TENANTS;
    expect(platform!.personas.map((persona) => persona.role)).toEqual(["SUPER_ADMIN"]);
    for (const tenant of [schoolA!, schoolB!]) {
      const roles = new Set(tenant.personas.map((persona) => persona.role));
      expect(roles.has("SUPER_ADMIN")).toBe(false);
      expect([...roles].sort()).toEqual(SCHOOL_ROLES);
    }
  });

  test("one documented login per role per school: 1 platform + 2 x 7", () => {
    expect(QA_LOGINS.length).toBe(15);
    expect(QA_LOGINS.filter((login) => login.school === "platform").map((l) => l.role)).toEqual([
      "SUPER_ADMIN",
    ]);
    for (const school of ["a", "b"] as const) {
      const roles = QA_LOGINS.filter((login) => login.school === school).map((l) => l.role);
      expect([...roles].sort()).toEqual(SCHOOL_ROLES);
    }
  });

  test("every email is unique across schools and on that school's reserved .test domain", () => {
    const emails = QA_TENANTS.flatMap((tenant) => tenant.personas.map((persona) => persona.email));
    expect(new Set(emails).size).toBe(emails.length);
    QA_TENANTS.forEach((tenant, index) => {
      const domain = `@${QA_SCHOOLS[index]!.emailDomain}`;
      expect(tenant.personas.every((persona) => persona.email.endsWith(domain))).toBe(true);
      expect(domain.endsWith(".studafy.test")).toBe(true);
    });
  });
});

describe("qa/ tooling", () => {
  test("accounts.json and the Bruno logins match the seeded roster (run `bun run qa:generate`)", async () => {
    const expected = renderQaFiles();
    for (const [path, content] of expected) {
      expect(await readFile(resolve(QA_DIR, path), "utf8")).toBe(content);
    }
    const committedLogins = (await readdir(resolve(QA_DIR, "bruno/Login"))).map(
      (name) => `bruno/Login/${name}`,
    );
    expect(committedLogins.sort()).toEqual(
      [...expected.keys()].filter((path) => path.startsWith("bruno/Login/")).sort(),
    );
  });
});

integrationTest(
  "provisions the platform school and two full QA schools next to the demo and review tenants",
  async () => {
    const database = await testDatabase();
    try {
      await runMigrationCommand("migrate", {
        env: runnerEnv(database.url, repositoryMigrations),
        log: () => undefined,
      });
      const env = { DATABASE_URL: database.url, DATABASE_SSL_MODE: "disable" };

      expect(
        (
          await seedReviewTenant({
            env: { ...env, REVIEW_TENANT_SEED_CONFIRM: REVIEW_TENANT.slug },
          })
        ).seeded,
      ).toBe(true);
      await expect(seedQaTenant(QA_TENANTS[0]!, { env })).rejects.toThrow(SeedSafetyError);

      const schoolIds: string[] = [];
      for (const tenant of QA_TENANTS) {
        const result = await seedQaTenant(tenant, { env: { ...env, ...CONFIRM } });
        expect(result.seeded).toBe(true);
        schoolIds.push(result.schoolId!);
      }
      const sql = database.sql;

      const flags = await sql<
        {
          slug: string;
          is_qa_tenant: boolean;
          is_review_tenant: boolean;
          is_platform_tenant: boolean;
        }[]
      >`
        SELECT slug, is_qa_tenant, is_review_tenant, is_platform_tenant FROM app.schools ORDER BY slug
      `;
      // Only the platform school may hold SUPER_ADMIN (000185), so it alone is a platform tenant.
      expect([...flags]).toEqual([
        {
          slug: "studafy-qa-platform",
          is_qa_tenant: true,
          is_review_tenant: false,
          is_platform_tenant: true,
        },
        {
          slug: "studafy-qa-school-a",
          is_qa_tenant: true,
          is_review_tenant: false,
          is_platform_tenant: false,
        },
        {
          slug: "studafy-qa-school-b",
          is_qa_tenant: true,
          is_review_tenant: false,
          is_platform_tenant: false,
        },
        {
          slug: REVIEW_TENANT.slug,
          is_qa_tenant: false,
          is_review_tenant: true,
          is_platform_tenant: false,
        },
      ]);

      // Every documented login resolves, under the qa provider, to its role in its own school.
      const slugByKey = Object.fromEntries(QA_SCHOOLS.map((school) => [school.key, school.slug]));
      for (const login of QA_LOGINS) {
        const rows = await sql<{ provider: string; slug: string; role: string }[]>`
          SELECT i.provider, s.slug, r.role::text AS role
          FROM app.oauth_identities i
          JOIN app.schools s ON s.id = i.school_id
          JOIN app.user_roles r ON r.user_id = i.user_id AND r.school_id = i.school_id
          WHERE i.subject = ${login.email.toLowerCase()}
        `;
        expect([...rows]).toEqual([
          { provider: QA_LOGIN_PROVIDER, slug: slugByKey[login.school]!, role: login.role },
        ]);
      }

      // SUPER_ADMIN exists only in the platform school, which holds nothing else.
      const superAdmins = await sql<{ school_id: string }[]>`
        SELECT school_id FROM app.user_roles WHERE role = 'SUPER_ADMIN'
      `;
      expect(superAdmins.map((row) => row.school_id)).toEqual([schoolIds[0]!]);
      const [{ count: platformUsers }] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.users WHERE school_id = ${schoolIds[0]!}::uuid
      `;
      expect(platformUsers).toBe(1);

      // Both schools carry the full dataset, and every QA address is suppressed.
      for (const schoolId of schoolIds.slice(1)) {
        const [{ classes }] = await sql<{ classes: number }[]>`
          SELECT count(*)::int AS classes FROM app.classes WHERE school_id = ${schoolId}::uuid
        `;
        expect(classes).toBeGreaterThan(0);
      }
      const [{ count: unsuppressed }] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.users u
        WHERE u.school_id IN ${sql(schoolIds)}
          AND NOT EXISTS (
            SELECT 1 FROM app.email_suppressions s
            WHERE s.address = u.normalized_email AND s.reason = 'qa_tenant'
          )
      `;
      expect(unsuppressed).toBe(0);

      // Re-running is a clean no-op per school.
      for (const tenant of QA_TENANTS) {
        expect((await seedQaTenant(tenant, { env: { ...env, ...CONFIRM } })).seeded).toBe(false);
      }
    } finally {
      await database.cleanup();
    }
  },
  180_000,
);
