import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
const TENANT_TABLES = ["subscriptions", "ai_subscriptions"] as const;

type Database = Awaited<ReturnType<typeof testDatabase>>;
type Role = "studafy_admin" | "studafy_app";

async function migratedDatabase(): Promise<Database> {
  const database = await testDatabase();
  await runMigrationCommand("migrate", {
    env: runnerEnv(database.url, repositoryMigrations),
    log: () => undefined,
  });
  return database;
}

async function asRole<T>(
  database: Database,
  role: Role,
  run: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await database.sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    result = await run(tx);
  });
  return result as T;
}

async function expectDenied(
  database: Database,
  statement: string,
  context?: string,
  role: Role = "studafy_app",
): Promise<void> {
  await asRole(database, role, async (tx) => {
    if (context !== undefined) await tx`SELECT set_config('app.school_id', ${context}, true)`;
    await tx.unsafe(`
      DO $expected_error$
      DECLARE failed boolean := false;
      BEGIN
        BEGIN EXECUTE $statement$${statement}$statement$;
        EXCEPTION WHEN OTHERS THEN failed := true;
        END;
        IF NOT failed THEN RAISE EXCEPTION 'expected statement to fail'; END IF;
      END
      $expected_error$
    `);
  });
}

async function createSchool(database: Database, slug: string): Promise<string> {
  const [refs] = await database.sql<{ country: string; currency: string }[]>`
    SELECT
      (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
      (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
  `;
  return asRole(database, "studafy_admin", async (tx) => {
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${slug}, ${slug}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`}, ${refs!.country}, ${refs!.currency})
      RETURNING id
    `;
    return school!.id;
  });
}

async function createSchoolAndPlan(database: Database): Promise<{ school: string; plan: string }> {
  const school = await createSchool(database, "subs-school");
  const plan = await asRole(database, "studafy_admin", async (tx) => {
    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name) VALUES ('growth', 'Growth') RETURNING id
    `;
    return plan!.id;
  });
  return { school, plan };
}

async function createStudent(database: Database, school: string, suffix: string): Promise<string> {
  // ST-085: app.students now carries a restrictive role_scope_visibility SELECT policy, which
  // PostgreSQL also applies to INSERT ... RETURNING. Seed as studafy_admin (still bound by
  // tenant_isolation, exempt from the TO studafy_app scope policy) so the fixture write is not
  // filtered by a per-user read scope it has no authenticated user for.
  return asRole(database, "studafy_admin", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    const email = `student-subs-${suffix}@example.test`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email)
      VALUES (${school}, ${email}, ${email}) RETURNING id
    `;
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
      VALUES (${school}, ${user!.id}, ${`ADM-SUBS-${suffix}`}, 'Ada', 'Lovelace') RETURNING id
    `;
    return student!.id;
  });
}

integrationTest(
  "installs the exact subscription/entitlement schema, ownership, grants, and forced policies",
  async () => {
    const database = await migratedDatabase();
    try {
      const [enum_] = await database.sql<{ values: string[] }[]>`
        SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE n.nspname = 'app' AND t.typname = 'subscription_status'
        GROUP BY t.typname
      `;
      expect(enum_!.values).toEqual([
        "trialing",
        "active",
        "past_due",
        "canceled",
        "expired",
        "grace_period",
        "closed",
      ]);

      const tenantTables = await database.sql<
        { name: string; owner: string; rls: boolean; forced: boolean; app_crud: boolean }[]
      >`
        SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
          c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
          has_table_privilege('studafy_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS app_crud
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY(${TENANT_TABLES as unknown as string[]})
        ORDER BY c.relname
      `;
      expect(tenantTables.map((row) => row.name)).toEqual([...TENANT_TABLES].sort());
      expect(
        tenantTables.every(
          (row) => row.owner === "studafy_admin" && row.rls && row.forced && row.app_crud,
        ),
      ).toBe(true);

      const tenantPolicies = await database.sql<{ table_name: string; name: string }[]>`
        SELECT c.relname AS table_name, p.polname AS name
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY(${TENANT_TABLES as unknown as string[]})
      `;
      expect(tenantPolicies).toHaveLength(2);
      expect(tenantPolicies.every((policy) => policy.name === "tenant_isolation")).toBe(true);

      // billing_events: global, forced RLS, scoped to studafy_admin only -- no tenant policy, no
      // studafy_app or PUBLIC grant.
      const [billingEvents] = await database.sql<
        {
          owner: string;
          rls: boolean;
          forced: boolean;
          app_crud: boolean;
          public_access: boolean;
          admin_crud: boolean;
        }[]
      >`
        SELECT pg_get_userbyid(c.relowner) AS owner,
          c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
          has_table_privilege('studafy_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS app_crud,
          has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS public_access,
          has_table_privilege('studafy_admin', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS admin_crud
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = 'billing_events'
      `;
      expect(billingEvents).toEqual({
        owner: "studafy_admin",
        rls: true,
        forced: true,
        app_crud: false,
        public_access: false,
        admin_crud: true,
      });

      const billingPolicies = await database.sql<{ name: string; roles: number[] }[]>`
        SELECT polname AS name, polroles::integer[] AS roles
        FROM pg_policy WHERE polrelid = 'app.billing_events'::regclass
      `;
      expect(billingPolicies).toHaveLength(1);
      expect(billingPolicies[0]!.name).toBe("global_admin_only");

      const [adminRoleOid] = await database.sql<{ oid: number }[]>`
        SELECT oid::integer AS oid FROM pg_roles WHERE rolname = 'studafy_admin'
      `;
      expect(billingPolicies[0]!.roles).toEqual([adminRoleOid!.oid]);
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "enforces one live subscription per school/student and valid billing periods",
  async () => {
    const database = await migratedDatabase();
    try {
      const { school, plan } = await createSchoolAndPlan(database);
      const student = await createStudent(database, school, "a");

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        await tx`
          INSERT INTO app.subscriptions
            (school_id, plan_id, status, current_period_start, current_period_end)
          VALUES (${school}, ${plan}, 'active', '2026-01-01', '2026-02-01')
        `;
        await tx`
          INSERT INTO app.ai_subscriptions
            (school_id, student_id, status, current_period_start, current_period_end)
          VALUES (${school}, ${student}, 'trialing', '2026-01-01', '2026-02-01')
        `;
      });

      // A second subscription for the same school is rejected by uq_subscriptions_school.
      await expectDenied(
        database,
        `INSERT INTO app.subscriptions
           (school_id, plan_id, status, current_period_start, current_period_end)
         VALUES ('${school}', '${plan}', 'active', '2026-02-01', '2026-03-01')`,
        school,
      );

      // A second AI entitlement for the same student is rejected by
      // uq_ai_subscriptions_school_student.
      await expectDenied(
        database,
        `INSERT INTO app.ai_subscriptions
           (school_id, student_id, status, current_period_start, current_period_end)
         VALUES ('${school}', '${student}', 'trialing', '2026-02-01', '2026-03-01')`,
        school,
      );

      // A period that does not end after it starts is rejected by ck_subscriptions_period, in
      // isolation from RLS/uniqueness: a fresh school with no prior subscription row, queried under
      // its own matching tenant context.
      const otherSchool = await createSchool(database, "subs-school-period");
      await expectDenied(
        database,
        `INSERT INTO app.subscriptions
           (school_id, plan_id, status, current_period_start, current_period_end)
         VALUES ('${otherSchool}', '${plan}', 'active', '2026-02-01', '2026-01-01')`,
        otherSchool,
      );

      // Same isolation for ck_ai_subscriptions_period: a second real student in the same school, so
      // only the period check -- not the FK or the uniqueness constraint -- can fail.
      const otherStudent = await createStudent(database, school, "b");
      await expectDenied(
        database,
        `INSERT INTO app.ai_subscriptions
           (school_id, student_id, status, current_period_start, current_period_end)
         VALUES ('${school}', '${otherStudent}', 'trialing', '2026-02-01', '2026-02-01')`,
        school,
      );

      // Transitioning the existing subscription in place (not inserting a new row) is allowed.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const updated = await tx`
          UPDATE app.subscriptions SET status = 'past_due' WHERE school_id = ${school}
        `;
        expect(updated.count).toBe(1);
      });
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "dedupes replayed billing webhooks by provider event id and isolates tenant rows",
  async () => {
    const database = await migratedDatabase();
    try {
      for (const table of TENANT_TABLES) {
        await expectDenied(database, `SELECT * FROM app.${table}`);
        for (const bad of ["", " ", "not-a-uuid"])
          await expectDenied(database, `SELECT * FROM app.${table}`, bad);
      }

      // effective_at is NOT NULL since 000078 (ST-132): a webhook that cannot say when the provider
      // thinks it happened cannot be ordered, and ordering is what makes out-of-order delivery safe.
      const event = (provider: string, id: string, type: string) =>
        `INSERT INTO app.billing_events (provider, provider_event_id, event_type, effective_at)
         VALUES ('${provider}', '${id}', '${type}', '2026-01-01T00:00:00Z')`;

      // studafy_app has no grant on billing_events at all -- denied before RLS is even reached.
      await expectDenied(database, "SELECT * FROM app.billing_events");
      await expectDenied(database, event("stripe", "evt_1", "invoice.paid"));

      // studafy_admin, the intended caller, may insert and read without any tenant context.
      const inserted = await asRole(database, "studafy_admin", async (tx) => {
        await tx.unsafe(event("stripe", "evt_1", "invoice.paid"));
        return tx<{ count: string }[]>`SELECT count(*)::text AS count FROM app.billing_events`;
      });
      expect(inserted[0]!.count).toBe("1");

      // Replaying the exact same provider event id is deduped by
      // uq_billing_events_provider_event_id. This is the constraint the webhook processor's
      // INSERT ... ON CONFLICT DO NOTHING claim relies on, so it is also the concurrency control.
      await expectDenied(
        database,
        event("stripe", "evt_1", "invoice.paid"),
        undefined,
        "studafy_admin",
      );

      // A different provider may reuse the same event id string -- the natural key is the pair.
      await asRole(database, "studafy_admin", async (tx) => {
        await tx.unsafe(event("paddle", "evt_1", "subscription.updated"));
      });
      const total = await asRole(
        database,
        "studafy_admin",
        (tx) => tx<{ count: string }[]>`SELECT count(*)::text AS count FROM app.billing_events`,
      );
      expect(total[0]!.count).toBe("2");

      // ST-132 processing columns. The row is mutable across retries -- that is the amendment 000078
      // makes to 000016's append-only description -- but a status must still agree with its evidence:
      // processed_at exists exactly when the status is 'processed', and a failure must say why.
      await asRole(database, "studafy_admin", async (tx) => {
        await tx`
          UPDATE app.billing_events
          SET status = 'processed', processed_at = CURRENT_TIMESTAMP, attempt_count = 1
          WHERE provider = 'stripe' AND provider_event_id = 'evt_1'
        `;
      });

      await expectDenied(
        database,
        `UPDATE app.billing_events SET status = 'processed'
         WHERE provider = 'paddle' AND provider_event_id = 'evt_1'`,
        undefined,
        "studafy_admin",
      );

      await expectDenied(
        database,
        `UPDATE app.billing_events SET status = 'dlq'
         WHERE provider = 'paddle' AND provider_event_id = 'evt_1'`,
        undefined,
        "studafy_admin",
      );

      // Half an attribution is refused: a row claiming a subscription type it has no id for would
      // read to the fold query as "this subscription has no history".
      await expectDenied(
        database,
        `UPDATE app.billing_events SET subscription_type = 'school'
         WHERE provider = 'paddle' AND provider_event_id = 'evt_1'`,
        undefined,
        "studafy_admin",
      );
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);
