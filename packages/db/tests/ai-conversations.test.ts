import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
const TENANT_TABLES = [
  "ai_conversations",
  "ai_message_citations",
  "ai_messages",
  "ai_usage_meters",
] as const;

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

async function createStudent(database: Database, school: string, suffix: string): Promise<string> {
  // ST-085: app.students now carries a restrictive role_scope_visibility SELECT policy, which
  // PostgreSQL also applies to INSERT ... RETURNING. Seed as studafy_admin (still bound by
  // tenant_isolation, exempt from the TO studafy_app scope policy) so the fixture write is not
  // filtered by a per-user read scope it has no authenticated user for.
  return asRole(database, "studafy_admin", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    const email = `student-ai-${suffix}@example.test`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email)
      VALUES (${school}, ${email}, ${email}) RETURNING id
    `;
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
      VALUES (${school}, ${user!.id}, ${`ADM-AI-${suffix}`}, 'Ada', 'Lovelace') RETURNING id
    `;
    return student!.id;
  });
}

async function createConversation(
  database: Database,
  school: string,
  studentId: string,
): Promise<string> {
  return asRole(database, "studafy_app", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    const [conv] = await tx<{ id: string }[]>`
      INSERT INTO app.ai_conversations (school_id, student_id, model)
      VALUES (${school}, ${studentId}, 'gpt-4o-mini')
      RETURNING id
    `;
    return conv!.id;
  });
}

async function createSubscription(
  database: Database,
  school: string,
  studentId: string,
): Promise<string> {
  return asRole(database, "studafy_app", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    const [sub] = await tx<{ id: string }[]>`
      INSERT INTO app.ai_subscriptions
        (school_id, student_id, status, current_period_start, current_period_end)
      VALUES (${school}, ${studentId}, 'active', now(), now() + INTERVAL '30 days')
      RETURNING id
    `;
    return sub!.id;
  });
}

// ---------------------------------------------------------------------------------------------------
// Schema, grants, and RLS
// ---------------------------------------------------------------------------------------------------

integrationTest(
  "installs the exact AI schema, ownership, grants, and forced policies",
  async () => {
    const database = await migratedDatabase();
    try {
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
      expect(tenantPolicies).toHaveLength(TENANT_TABLES.length);
      expect(tenantPolicies.every((policy) => policy.name === "tenant_isolation")).toBe(true);

      // Functions exist and are executable by studafy_app.
      const functions = await database.sql<{ name: string }[]>`
        SELECT p.proname AS name
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.proname IN ('upsert_ai_usage_tokens', 'delete_expired_ai_messages')
        ORDER BY p.proname
      `;
      expect(functions.map((f) => f.name)).toEqual([
        "delete_expired_ai_messages",
        "upsert_ai_usage_tokens",
      ]);
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

// ---------------------------------------------------------------------------------------------------
// RLS enforcement
// ---------------------------------------------------------------------------------------------------

integrationTest(
  "enforces tenant isolation on AI tables",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "ai-school-a");
      const schoolB = await createSchool(database, "ai-school-b");
      const studentA = await createStudent(database, schoolA, "a");
      const convA = await createConversation(database, schoolA, studentA);

      // schoolA inserts a message visible within its context.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`
          INSERT INTO app.ai_messages
            (school_id, conversation_id, question, answer, prompt_tokens, completion_tokens,
             total_tokens, expires_at)
          VALUES (${schoolA}, ${convA}, 'What is photosynthesis?',
                  'It is the process...', 100, 50, 150, now() + INTERVAL '90 days')
        `;
      });

      // schoolB cannot see schoolA's messages.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolB}, true)`;
        const rows = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.ai_messages
        `;
        expect(rows[0]!.count).toBe("0");
      });

      // schoolB cannot see schoolA's conversations.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolB}, true)`;
        const rows = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.ai_conversations
        `;
        expect(rows[0]!.count).toBe("0");
      });

      // Missing school_id context is rejected (RLS policy requires app.school_id).
      await expectDenied(database, `SELECT * FROM app.ai_messages`);
      await expectDenied(database, `SELECT * FROM app.ai_conversations`);
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

// ---------------------------------------------------------------------------------------------------
// Atomic upsert
// ---------------------------------------------------------------------------------------------------

integrationTest(
  "upsert_ai_usage_tokens is atomic under concurrent-like increments",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "ai-upsert-school");
      const student = await createStudent(database, school, "u");
      const subscription = await createSubscription(database, school, student);

      // First upsert: inserts a new row with 200 tokens.
      const first = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [row] = await tx<{ upsert_ai_usage_tokens: string }[]>`
          SELECT app.upsert_ai_usage_tokens(${student}, ${subscription}, 200)
        `;
        return row!.upsert_ai_usage_tokens;
      });
      expect(first).toBe("200");

      // Second upsert: same student+subscription, increments by 100 (total = 300).
      const second = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [row] = await tx<{ upsert_ai_usage_tokens: string }[]>`
          SELECT app.upsert_ai_usage_tokens(${student}, ${subscription}, 100)
        `;
        return row!.upsert_ai_usage_tokens;
      });
      expect(second).toBe("300");

      // Verify exactly one row exists (upsert, not insert).
      const [count] = await database.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM app.ai_usage_meters
      `;
      expect(count!.count).toBe("1");

      // Verify the stored total.
      const [row] = await database.sql<{ total_tokens: string }[]>`
        SELECT total_tokens::text FROM app.ai_usage_meters
      `;
      expect(row!.total_tokens).toBe("300");
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

// ---------------------------------------------------------------------------------------------------
// Retention cleanup
// ---------------------------------------------------------------------------------------------------

integrationTest(
  "delete_expired_ai_messages deletes only messages past expires_at",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "ai-retention-school");
      const student = await createStudent(database, school, "r");
      const conv = await createConversation(database, school, student);

      // Insert an expired message (created 91d ago, expired 1d ago) and a fresh message.
      let expiredId: string;
      let freshId: string;
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [expired] = await tx<{ id: string }[]>`
          INSERT INTO app.ai_messages
            (school_id, conversation_id, question, answer, prompt_tokens, completion_tokens,
             total_tokens, created_at, expires_at)
          VALUES (${school}, ${conv}, 'old question', 'old answer', 10, 5, 15,
                  now() - INTERVAL '91 days', now() - INTERVAL '1 day')
          RETURNING id
        `;
        expiredId = expired!.id;
        const [fresh] = await tx<{ id: string }[]>`
          INSERT INTO app.ai_messages
            (school_id, conversation_id, question, answer, prompt_tokens, completion_tokens,
             total_tokens, expires_at)
          VALUES (${school}, ${conv}, 'new question', 'new answer', 20, 10, 30,
                  now() + INTERVAL '90 days')
          RETURNING id
        `;
        freshId = fresh!.id;
      });

      // Run the retention cleanup.
      const deleted = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [row] = await tx<{ delete_expired_ai_messages: number }[]>`
          SELECT app.delete_expired_ai_messages(1000)
        `;
        return row!.delete_expired_ai_messages;
      });
      expect(deleted).toBe(1);

      // Fresh message must survive.
      const [surviving] = await database.sql<{ id: string }[]>`
        SELECT id::text FROM app.ai_messages WHERE id = ${freshId!} AND school_id = ${school}
      `;
      expect(surviving).toBeDefined();

      // Expired message must be gone.
      const [gone] = await database.sql<{ id: string | null }[]>`
        SELECT id::text FROM app.ai_messages WHERE id = ${expiredId!} AND school_id = ${school}
      `;
      expect(gone).toBeUndefined();
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

integrationTest(
  "delete_expired_ai_messages respects batch size limit",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "ai-batch-school");
      const student = await createStudent(database, school, "b");
      const conv = await createConversation(database, school, student);

      // Insert 3 expired messages (created 91d ago, expired 1d ago).
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        for (let i = 0; i < 3; i++) {
          await tx`
            INSERT INTO app.ai_messages
              (school_id, conversation_id, question, answer, prompt_tokens, completion_tokens,
               total_tokens, created_at, expires_at)
            VALUES (${school}, ${conv}, ${`q${i}`}, ${`a${i}`}, 10, 5, 15,
                    now() - INTERVAL '91 days', now() - INTERVAL '1 day')
          `;
        }
      });

      // Batch size of 2 should delete only 2.
      const deleted = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [row] = await tx<{ delete_expired_ai_messages: number }[]>`
          SELECT app.delete_expired_ai_messages(2)
        `;
        return row!.delete_expired_ai_messages;
      });
      expect(deleted).toBe(2);

      // One expired message remains.
      const [remaining] = await database.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM app.ai_messages WHERE school_id = ${school}
      `;
      expect(remaining!.count).toBe("1");

      // Second call cleans up the last one.
      const deleted2 = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [row] = await tx<{ delete_expired_ai_messages: number }[]>`
          SELECT app.delete_expired_ai_messages(1000)
        `;
        return row!.delete_expired_ai_messages;
      });
      expect(deleted2).toBe(1);

      const [empty] = await database.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM app.ai_messages WHERE school_id = ${school}
      `;
      expect(empty!.count).toBe("0");
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

// ---------------------------------------------------------------------------------------------------
// CHECK constraints
// ---------------------------------------------------------------------------------------------------

integrationTest(
  "enforces CHECK constraints on AI tables",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "ai-checks-school");
      const student = await createStudent(database, school, "c");
      const conv = await createConversation(database, school, student);

      // Empty model is rejected.
      await expectDenied(
        database,
        `INSERT INTO app.ai_conversations (school_id, student_id, model)
         VALUES ('${school}', '${student}', '')`,
        school,
      );

      // total_tokens != prompt + completion is rejected.
      await expectDenied(
        database,
        `INSERT INTO app.ai_messages
           (school_id, conversation_id, question, answer, prompt_tokens, completion_tokens,
            total_tokens, expires_at)
         VALUES ('${school}', '${conv}', 'q', 'a', 100, 50, 999, now() + INTERVAL '90 days')`,
        school,
      );

      // prompt_tokens <= 0 is rejected.
      await expectDenied(
        database,
        `INSERT INTO app.ai_messages
           (school_id, conversation_id, question, answer, prompt_tokens, completion_tokens,
            total_tokens, expires_at)
         VALUES ('${school}', '${conv}', 'q', 'a', 0, 0, 0, now() + INTERVAL '90 days')`,
        school,
      );

      // total_tokens < 0 is rejected.
      await expectDenied(
        database,
        `INSERT INTO app.ai_usage_meters (school_id, student_id, ai_subscription_id, total_tokens)
         VALUES ('${school}', '${student}', '${student}', -1)`,
        school,
      );
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);
