import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { ReservedSql, TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

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
      INSERT INTO app.schools (slug, name, country_id, default_currency_id)
      VALUES (${slug}, ${slug}, ${refs!.country}, ${refs!.currency})
      RETURNING id
    `;
    return school!.id;
  });
}

integrationTest(
  "installs the exact outbox_events schema, ownership, grants, forced RLS, and relay index",
  async () => {
    const database = await migratedDatabase();
    try {
      const [table] = await database.sql<
        {
          owner: string;
          rls: boolean;
          forced: boolean;
          app_crud: boolean;
          public_access: boolean;
        }[]
      >`
        SELECT pg_get_userbyid(c.relowner) AS owner,
          c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
          has_table_privilege('studafy_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS app_crud,
          has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS public_access
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = 'outbox_events'
      `;
      expect(table).toEqual({
        owner: "studafy_admin",
        rls: true,
        forced: true,
        app_crud: true,
        public_access: false,
      });

      const [policy] = await database.sql<{ name: string }[]>`
        SELECT p.polname AS name
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = 'outbox_events'
      `;
      expect(policy!.name).toBe("tenant_isolation");

      const [index] = await database.sql<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'app' AND tablename = 'outbox_events'
          AND indexname = 'idx_outbox_events_school_unrelayed'
      `;
      expect(index!.indexdef).toContain("(school_id, id)");
      expect(index!.indexdef).toContain("relayed_at IS NULL");
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "enforces event_name shape and relayed_at-not-before-created_at",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "outbox-constraints");

      await expectDenied(
        database,
        `INSERT INTO app.outbox_events (school_id, event_name, payload)
         VALUES ('${school}', 'not a valid event name', '{}'::jsonb)`,
        school,
      );
      await expectDenied(
        database,
        `INSERT INTO app.outbox_events (school_id, event_name, payload)
         VALUES ('${school}', 'UPPER.CASE', '{}'::jsonb)`,
        school,
      );
      await expectDenied(
        database,
        `INSERT INTO app.outbox_events (school_id, event_name, payload, relayed_at)
         VALUES ('${school}', 'user.created', '{}'::jsonb, CURRENT_TIMESTAMP - interval '1 hour')`,
        school,
      );

      const inserted = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [row] = await tx<{ id: string; relayed_at: string | null }[]>`
          INSERT INTO app.outbox_events (school_id, event_name, payload)
          VALUES (${school}, 'user.created', '{"userId": "11111111-1111-1111-1111-111111111111"}'::jsonb)
          RETURNING id, relayed_at
        `;
        return row!;
      });
      expect(inserted.id).toBeTruthy();
      expect(inserted.relayed_at).toBeNull();
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "writes the outbox row in the same transaction as the domain write, atomically",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "outbox-same-tx");
      const committedEmail = "outbox-committed@example.test";
      const rolledBackEmail = "outbox-rolled-back@example.test";

      // Domain write (app.users) and outbox insert commit together in one transaction.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [user] = await tx<{ id: string }[]>`
          INSERT INTO app.users (school_id, email, normalized_email)
          VALUES (${school}, ${committedEmail}, ${committedEmail})
          RETURNING id
        `;
        await tx.unsafe(
          `INSERT INTO app.outbox_events (school_id, event_name, payload)
           VALUES ($1, 'user.created', $2::jsonb)`,
          [school, JSON.stringify({ userId: user!.id })],
        );
      });

      const committed = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        return tx<{ users: string; events: string }[]>`
          SELECT
            (SELECT count(*)::text FROM app.users WHERE email = ${committedEmail}) AS users,
            (SELECT count(*)::text FROM app.outbox_events WHERE event_name = 'user.created') AS events
        `;
      });
      expect(committed[0]).toEqual({ users: "1", events: "1" });

      // Same transaction, but the outbox insert violates a CHECK constraint -- the whole
      // transaction, including the preceding domain write, must roll back together.
      let threw = false;
      try {
        await asRole(database, "studafy_app", async (tx) => {
          await tx`SELECT set_config('app.school_id', ${school}, true)`;
          await tx`
            INSERT INTO app.users (school_id, email, normalized_email)
            VALUES (${school}, ${rolledBackEmail}, ${rolledBackEmail})
          `;
          await tx`
            INSERT INTO app.outbox_events (school_id, event_name, payload)
            VALUES (${school}, 'not a valid event name', '{}'::jsonb)
          `;
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      const rolledBack = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        return tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.users WHERE email = ${rolledBackEmail}
        `;
      });
      expect(rolledBack[0]!.count).toBe("0");
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "relay claims unrelayed rows exactly once under concurrent relayers",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "outbox-relay-race");
      const total = 10;

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        for (let i = 0; i < total; i += 1) {
          await tx.unsafe(
            `INSERT INTO app.outbox_events (school_id, event_name, payload)
             VALUES ($1, 'user.created', $2::jsonb)`,
            [school, JSON.stringify({ i })],
          );
        }
      });

      const claim = async (connection: ReservedSql, limit: number): Promise<{ id: string }[]> =>
        connection<{ id: string }[]>`
          UPDATE app.outbox_events SET relayed_at = CURRENT_TIMESTAMP
          WHERE id IN (
            SELECT id FROM app.outbox_events
            WHERE school_id = ${school} AND relayed_at IS NULL
            ORDER BY id
            FOR UPDATE SKIP LOCKED
            LIMIT ${limit}
          )
          RETURNING id
        `;

      // Two independent reserved connections stand in for two concurrent relayer instances.
      // relayer1's claim locks its rows and stays open (uncommitted) while relayer2 claims from
      // the same unrelayed set -- SKIP LOCKED must make relayer2 skip relayer1's locked rows, so
      // the two claims are provably disjoint even though relayer1 has not committed yet.
      const relayer1 = await database.sql.reserve();
      const relayer2 = await database.sql.reserve();
      try {
        await relayer1.unsafe("BEGIN");
        await relayer1.unsafe("SET LOCAL ROLE studafy_app");
        await relayer1`SELECT set_config('app.school_id', ${school}, true)`;

        await relayer2.unsafe("BEGIN");
        await relayer2.unsafe("SET LOCAL ROLE studafy_app");
        await relayer2`SELECT set_config('app.school_id', ${school}, true)`;

        const claimed1 = await claim(relayer1, 4);
        const claimed2 = await claim(relayer2, total);

        await relayer1.unsafe("COMMIT");
        await relayer2.unsafe("COMMIT");

        const ids1 = claimed1.map((row) => row.id);
        const ids2 = claimed2.map((row) => row.id);

        expect(ids1).toHaveLength(4);
        // relayer2 could only see the remaining rows relayer1 had not locked.
        expect(ids2).toHaveLength(total - 4);
        expect(ids1.some((id) => ids2.includes(id))).toBe(false);
        expect(new Set([...ids1, ...ids2]).size).toBe(total);
      } finally {
        relayer1.release();
        relayer2.release();
      }

      const remaining = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        return tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.outbox_events WHERE relayed_at IS NULL
        `;
      });
      expect(remaining[0]!.count).toBe("0");
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "fails closed and isolates outbox_events reads and writes per tenant",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "outbox-rls-a");
      const schoolB = await createSchool(database, "outbox-rls-b");

      await expectDenied(database, "SELECT * FROM app.outbox_events");
      for (const bad of ["", " ", "not-a-uuid"])
        await expectDenied(database, "SELECT * FROM app.outbox_events", bad);

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`
          INSERT INTO app.outbox_events (school_id, event_name, payload)
          VALUES (${schoolA}, 'user.created', '{}'::jsonb)
        `;
      });

      const crossTenantCount = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolB}, true)`;
        return tx<{ count: string }[]>`SELECT count(*)::text AS count FROM app.outbox_events`;
      });
      expect(crossTenantCount[0]!.count).toBe("0");

      await expectDenied(
        database,
        `UPDATE app.outbox_events SET school_id = '${schoolB}'`,
        schoolA,
      );

      // FORCE applies to the table owner too; missing owner context cannot read rows.
      await expectDenied(database, "SELECT * FROM app.outbox_events", undefined, "studafy_admin");
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);
