import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { ensureAuditLogPartitions } from "../src/audit-partitions";
import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

// The fixed initial range 000018 creates: previous month, current month, and six ahead of 2026-07.
const INITIAL_PARTITIONS = [
  "audit_logs_y2026m06",
  "audit_logs_y2026m07",
  "audit_logs_y2026m08",
  "audit_logs_y2026m09",
  "audit_logs_y2026m10",
  "audit_logs_y2026m11",
  "audit_logs_y2026m12",
  "audit_logs_y2027m01",
] as const;

const AUDIT_ACTIONS = [
  "insert",
  "update",
  "delete",
  "login",
  "logout",
  "export",
  "permission_change",
] as const;

// pk_audit_logs, uq_audit_logs_id_school_created, and the three deliberate composites. Declared once on
// the parent; PostgreSQL propagates a partition-local index of each to every partition.
const INDEXES_PER_PARTITION = 5;

// Bound as timestamptz parameters, so they must be strings JavaScript's Date can parse: postgres.js
// serializes a timestamptz parameter through Date, and "+00" (unlike "Z" or "+00:00") is not a valid
// ISO 8601 offset for it. SQL literals embedded in a query string have no such constraint.
const IN_JULY = "2026-07-15T12:00:00Z";
const IN_AUGUST = "2026-08-15T12:00:00Z";
// Beyond the fixed initial range and beyond anything the maintenance job would create from "now".
const UNCOVERED = "2030-03-01T00:00:00Z";

type Database = Awaited<ReturnType<typeof testDatabase>>;
type Role = "studafy_admin" | "studafy_app";
interface Context {
  school: string;
  user?: string;
}

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

// Forced RLS binds studafy_admin too, so even the admin paths below must carry a tenant context.
async function asUser<T>(
  database: Database,
  context: Context,
  run: (tx: TransactionSql) => Promise<T>,
  role: Role = "studafy_app",
): Promise<T> {
  return asRole(database, role, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${context.school}, true)`;
    if (context.user !== undefined)
      await tx`SELECT set_config('app.user_id', ${context.user}, true)`;
    return run(tx);
  });
}

// Asserts the statement fails and returns the SQLSTATE, so a test can prove *why* it failed. The
// distinction matters here: a denied UPDATE must be a privilege failure (42501), never a silent
// zero-row no-op, and a row in an uncovered month must be a routing failure (23514), never a default
// partition quietly absorbing it.
async function expectFailure(
  database: Database,
  role: Role,
  context: Context | undefined,
  run: (tx: TransactionSql) => Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await asRole(database, role, async (tx) => {
      if (context !== undefined) {
        await tx`SELECT set_config('app.school_id', ${context.school}, true)`;
        if (context.user !== undefined)
          await tx`SELECT set_config('app.user_id', ${context.user}, true)`;
      }
      await run(tx);
    });
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { code: failure.code ?? "", message: failure.message ?? "" };
  }
  throw new Error("expected the statement to fail, but it succeeded");
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

async function createUser(database: Database, school: string, suffix: string): Promise<string> {
  return asUser(database, { school }, async (tx) => {
    const email = `audit-${suffix}@example.test`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, ${email}, ${email}, 'active'::app.user_status)
      RETURNING id
    `;
    return user!.id;
  });
}

// A record state, as the audit log stores it: a flat JSON object of column values, or nothing.
type Payload = Record<string, string | number | boolean | null> | null;

// postgres.js needs sql.json() to bind an object as a jsonb parameter: a bare object is not an accepted
// parameter type, and pre-stringifying it instead double-encodes -- the driver serializes the string
// again, and the column ends up holding a jsonb *string* rather than an object, which
// ck_audit_logs_{old,new}_values then correctly rejects.
//
// An absent payload must be a SQL NULL, not tx.json(null): the latter is the jsonb value 'null', whose
// jsonb_typeof is 'null' rather than 'object', and the check constraint rejects that too.
function payload(tx: TransactionSql, value: Payload) {
  return value === null ? null : tx.json(value);
}

// One audit row, appended the way the application is expected to append: as studafy_app, in one
// transaction, with the tenant context set and every control on.
async function append(
  database: Database,
  context: Context,
  row: {
    actor?: string | null;
    action?: (typeof AUDIT_ACTIONS)[number];
    targetTable?: string;
    targetId?: string;
    oldValues?: Payload;
    newValues?: Payload;
    createdAt?: string;
  } = {},
): Promise<{ id: string; partition: string }> {
  const oldValues = row.oldValues === undefined ? { status: "invited" } : row.oldValues;
  const newValues = row.newValues === undefined ? { status: "active" } : row.newValues;

  return asUser(database, context, async (tx) => {
    const [appended] = await tx<{ id: string; partition: string }[]>`
      INSERT INTO app.audit_logs (
        school_id, actor_id, action, target_table, target_id, old_values, new_values,
        client_ip, user_agent, created_at
      )
      VALUES (
        ${context.school},
        ${row.actor ?? null},
        ${row.action ?? "update"}::app.audit_action,
        ${row.targetTable ?? "users"},
        COALESCE(${row.targetId ?? null}::uuid, gen_random_uuid()),
        ${payload(tx, oldValues)}::jsonb,
        ${payload(tx, newValues)}::jsonb,
        ${"203.0.113.7"}::inet,
        ${"studafy-test/1.0"},
        ${row.createdAt ?? IN_JULY}::timestamptz
      )
      RETURNING id, tableoid::regclass::text AS partition
    `;
    return appended!;
  });
}

integrationTest(
  "installs the audit schema, append-only grants, and forced RLS on the parent and every partition",
  async () => {
    const database = await migratedDatabase();
    try {
      const [action] = await database.sql<{ values: string[] }[]>`
        SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE n.nspname = 'app' AND t.typname = 'audit_action'
      `;
      expect(action!.values).toEqual([...AUDIT_ACTIONS]);

      // The parent is a partitioned table (relkind 'p') partitioned by range on created_at, with no
      // default partition. A default partition would silently absorb misrouted rows.
      const [parent] = await database.sql<
        { kind: string; strategy: string; key: string; defaults: string }[]
      >`
        SELECT c.relkind::text AS kind,
               p.partstrat::text AS strategy,
               pg_get_partkeydef(c.oid) AS key,
               (SELECT count(*)::text FROM pg_class d
                 JOIN pg_inherits i ON i.inhrelid = d.oid
                WHERE i.inhparent = c.oid AND d.relpartbound IS NOT NULL
                  AND pg_get_expr(d.relpartbound, d.oid) = 'DEFAULT') AS defaults
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_partitioned_table p ON p.partrelid = c.oid
        WHERE n.nspname = 'app' AND c.relname = 'audit_logs'
      `;
      expect(parent).toEqual({
        kind: "p",
        strategy: "r",
        key: "RANGE (created_at)",
        defaults: "0",
      });

      // The security posture, asserted identically for the parent and for every leaf. This is the whole
      // point of the exercise: RLS does not cascade to partitions and grants are not inherited, so a
      // partition that missed any of this would be both a tenant-isolation hole and a mutable audit log.
      const relations = await database.sql<
        {
          name: string;
          owner: string;
          rls: boolean;
          forced: boolean;
          policy: string;
          app_select: boolean;
          app_insert: boolean;
          app_update: boolean;
          app_delete: boolean;
          app_truncate: boolean;
          public_any: boolean;
        }[]
      >`
        SELECT c.relname AS name,
               pg_get_userbyid(c.relowner) AS owner,
               c.relrowsecurity AS rls,
               c.relforcerowsecurity AS forced,
               (SELECT count(*)::text FROM pg_policy p
                 WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy,
               has_table_privilege('studafy_app', c.oid, 'SELECT') AS app_select,
               has_table_privilege('studafy_app', c.oid, 'INSERT') AS app_insert,
               has_table_privilege('studafy_app', c.oid, 'UPDATE') AS app_update,
               has_table_privilege('studafy_app', c.oid, 'DELETE') AS app_delete,
               has_table_privilege('studafy_app', c.oid, 'TRUNCATE') AS app_truncate,
               has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
                 AS public_any
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app'
          -- Indexes live in pg_class too, and are named after the table they sit on, so without this
          -- the LIKE below would match five index relations per partition.
          AND c.relkind IN ('r', 'p')
          AND (c.relname = 'audit_logs' OR c.relname LIKE 'audit_logs_y%')
        ORDER BY c.relname
      `;

      expect(relations.map((row) => row.name)).toEqual([
        "audit_logs",
        ...[...INITIAL_PARTITIONS].sort(),
      ]);
      for (const relation of relations) {
        expect(relation).toMatchObject({
          owner: "studafy_admin",
          rls: true,
          forced: true,
          policy: "1",
          // Append-only, everywhere. Note this is not the default state: 000002's ALTER DEFAULT
          // PRIVILEGES grants studafy_app full CRUD on every new table in this schema, so each of these
          // false values is the explicit REVOKE in 000018 doing its job.
          app_select: true,
          app_insert: true,
          app_update: false,
          app_delete: false,
          app_truncate: false,
          public_any: false,
        });
      }

      // The parent's indexes propagate to every partition; the maintenance function never creates them.
      const indexes = await database.sql<{ partition: string; count: string }[]>`
        SELECT c.relname AS partition, count(i.indexrelid)::text AS count
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_index i ON i.indrelid = c.oid
        WHERE n.nspname = 'app' AND c.relkind = 'r' AND c.relname LIKE 'audit_logs_y%'
        GROUP BY c.relname
        ORDER BY c.relname
      `;
      expect(indexes).toHaveLength(INITIAL_PARTITIONS.length);
      for (const row of indexes) expect(row.count).toBe(String(INDEXES_PER_PARTITION));

      // The append-only trigger is cloned to every partition, so naming a partition directly is rejected
      // exactly like naming the parent.
      const triggers = await database.sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app'
          AND c.relkind IN ('r', 'p')
          AND NOT t.tgisinternal
          AND t.tgname = 'trg_audit_logs_append_only'
          AND (c.relname = 'audit_logs' OR c.relname LIKE 'audit_logs_y%')
      `;
      expect(triggers[0]!.count).toBe(String(1 + INITIAL_PARTITIONS.length));

      // studafy_app cannot run the partition DDL helpers even though it can append audit rows.
      const [helpers] = await database.sql<{ app_execute: boolean; admin_execute: boolean }[]>`
        SELECT
          bool_or(has_function_privilege('studafy_app', p.oid, 'EXECUTE')) AS app_execute,
          bool_and(has_function_privilege('studafy_admin', p.oid, 'EXECUTE')) AS admin_execute
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.proname IN ('create_audit_log_partitions', 'ensure_audit_log_partitions')
      `;
      expect(helpers).toEqual({ app_execute: false, admin_execute: true });
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "routes rows to the monthly partition and fails loudly when no partition covers the month",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "audit-routing");
      const actor = await createUser(database, school, "router");

      const july = await append(database, { school }, { actor, createdAt: IN_JULY });
      expect(july.partition).toBe("app.audit_logs_y2026m07");

      const august = await append(database, { school }, { actor, createdAt: IN_AUGUST });
      expect(august.partition).toBe("app.audit_logs_y2026m08");

      // Half-open bounds: the first instant of August belongs to August, not to July.
      const boundary = await append(
        database,
        { school },
        { actor, createdAt: "2026-08-01T00:00:00Z" },
      );
      expect(boundary.partition).toBe("app.audit_logs_y2026m08");
      const lastInstantOfJuly = await append(
        database,
        { school },
        { actor, createdAt: "2026-07-31T23:59:59.999Z" },
      );
      expect(lastInstantOfJuly.partition).toBe("app.audit_logs_y2026m07");

      // There is no DEFAULT partition, deliberately. An uncovered month must be a loud, immediately
      // fixable error, not a row filed somewhere nobody looks.
      const uncovered = await expectFailure(database, "studafy_app", { school }, async (tx) => {
        await tx`
          INSERT INTO app.audit_logs (school_id, actor_id, action, target_table, target_id, new_values, created_at)
          VALUES (${school}, ${actor}, 'insert', 'users', gen_random_uuid(), '{}'::jsonb, ${UNCOVERED}::timestamptz)
        `;
      });
      expect(uncovered.code).toBe("23514");
      expect(uncovered.message).toContain("no partition of relation");
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "is strictly append-only: studafy_app holds no UPDATE, DELETE, or TRUNCATE on parent or partition",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "audit-append-only");
      const actor = await createUser(database, school, "appender");
      const appended = await append(database, { school }, { actor });

      // The two grants it does have.
      const rows = await asUser(
        database,
        { school },
        (tx) => tx<{ id: string }[]>`SELECT id FROM app.audit_logs`,
      );
      expect(rows.map((row) => row.id)).toEqual([appended.id]);

      // Every mutation, against the parent AND against the partition by name. Naming the partition
      // directly is the bypass a partitioned table invites, so it is tested explicitly rather than
      // assumed to be covered by the parent.
      for (const relation of ["app.audit_logs", "app.audit_logs_y2026m07"]) {
        const update = await expectFailure(database, "studafy_app", { school }, (tx) =>
          tx.unsafe(`UPDATE ${relation} SET action = 'delete'`),
        );
        expect(update.code).toBe("42501");

        const remove = await expectFailure(database, "studafy_app", { school }, (tx) =>
          tx.unsafe(`DELETE FROM ${relation}`),
        );
        expect(remove.code).toBe("42501");

        const truncate = await expectFailure(database, "studafy_app", { school }, (tx) =>
          tx.unsafe(`TRUNCATE ${relation}`),
        );
        expect(truncate.code).toBe("42501");
      }

      // The row survived every attempt.
      const survivors = await asUser(
        database,
        { school },
        (tx) => tx<{ count: string }[]>`SELECT count(*)::text AS count FROM app.audit_logs`,
      );
      expect(survivors[0]!.count).toBe("1");
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "is immutable even to studafy_admin, which owns the table and is not bound by grants",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "audit-immutable");
      const actor = await createUser(database, school, "owner");
      await append(database, { school }, { actor });

      // studafy_admin *does* hold UPDATE and DELETE here -- it is the owner. The trigger is what stops
      // it, which is the difference between "the application cannot rewrite history" and "nobody can".
      const [privileges] = await database.sql<{ update: boolean; delete: boolean }[]>`
        SELECT has_table_privilege('studafy_admin', 'app.audit_logs', 'UPDATE') AS update,
               has_table_privilege('studafy_admin', 'app.audit_logs', 'DELETE') AS delete
      `;
      expect(privileges).toEqual({ update: true, delete: true });

      for (const relation of ["app.audit_logs", "app.audit_logs_y2026m07"]) {
        const update = await expectFailure(database, "studafy_admin", { school }, (tx) =>
          tx.unsafe(`UPDATE ${relation} SET user_agent = 'tampered'`),
        );
        expect(update.code).toBe("42501");
        expect(update.message).toContain("append-only");

        const remove = await expectFailure(database, "studafy_admin", { school }, (tx) =>
          tx.unsafe(`DELETE FROM ${relation}`),
        );
        expect(remove.code).toBe("42501");
        expect(remove.message).toContain("append-only");
      }

      const survivors = await asUser(
        database,
        { school },
        (tx) => tx<{ count: string }[]>`SELECT count(*)::text AS count FROM app.audit_logs`,
        "studafy_admin",
      );
      expect(survivors[0]!.count).toBe("1");
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "isolates every tenant read and write path, including partitions named directly",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "audit-tenant-a");
      const schoolB = await createSchool(database, "audit-tenant-b");
      const actorA = await createUser(database, schoolA, "tenant-a");
      const actorB = await createUser(database, schoolB, "tenant-b");

      await append(database, { school: schoolA }, { actor: actorA, targetTable: "classes" });
      await append(database, { school: schoolB }, { actor: actorB, targetTable: "classes" });

      // Each tenant sees exactly its own row, through the parent.
      for (const [school, expected] of [
        [schoolA, schoolA],
        [schoolB, schoolB],
      ] as const) {
        const visible = await asUser(
          database,
          { school },
          (tx) => tx<{ school_id: string }[]>`SELECT school_id FROM app.audit_logs`,
        );
        expect(visible.map((row) => row.school_id)).toEqual([expected]);
      }

      // ...and through the partition named directly. RLS does not cascade from the parent, so this is
      // the assertion that proves app.create_audit_log_partitions installed the policy on the leaf.
      const leaf = await asUser(
        database,
        { school: schoolA },
        (tx) => tx<{ school_id: string }[]>`SELECT school_id FROM app.audit_logs_y2026m07`,
      );
      expect(leaf.map((row) => row.school_id)).toEqual([schoolA]);

      // A cross-tenant append is rejected by the policy's WITH CHECK, not silently retenanted.
      const crossTenant = await expectFailure(
        database,
        "studafy_app",
        { school: schoolA },
        (tx) => tx`
          INSERT INTO app.audit_logs (school_id, action, target_table, target_id, new_values)
          VALUES (${schoolB}, 'insert', 'users', gen_random_uuid(), '{}'::jsonb)
        `,
      );
      expect(crossTenant.code).toBe("42501");

      // Fail-closed: no tenant context, or a malformed one, sees nothing and raises rather than
      // defaulting to some tenant.
      for (const context of [undefined, { school: "" }, { school: "not-a-uuid" }]) {
        const denied = await expectFailure(
          database,
          "studafy_app",
          context,
          (tx) => tx`SELECT * FROM app.audit_logs`,
        );
        expect(denied.code).not.toBe("");
      }
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "constrains the payload to the verb and the JSONB to objects",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "audit-payload");
      const actor = await createUser(database, school, "payload");

      // The delta must be reconstructible from the verb: an insert has no prior state, a delete has no
      // subsequent state, an update has both.
      const contradictions: {
        action: "insert" | "update" | "delete";
        old: Payload;
        new: Payload;
      }[] = [
        { action: "insert", old: { a: 1 }, new: { a: 2 } },
        { action: "insert", old: null, new: null },
        { action: "update", old: null, new: { a: 2 } },
        { action: "delete", old: { a: 1 }, new: { a: 2 } },
      ];
      for (const row of contradictions) {
        const failure = await expectFailure(
          database,
          "studafy_app",
          { school },
          (tx) => tx`
            INSERT INTO app.audit_logs (
              school_id, actor_id, action, target_table, target_id, old_values, new_values
            )
            VALUES (
              ${school}, ${actor}, ${row.action}::app.audit_action, 'users', gen_random_uuid(),
              ${payload(tx, row.old)}::jsonb, ${payload(tx, row.new)}::jsonb
            )
          `,
        );
        expect(failure.code).toBe("23514");
      }

      // A scalar JSONB payload is not a record state.
      const scalar = await expectFailure(
        database,
        "studafy_app",
        { school },
        (tx) => tx`
          INSERT INTO app.audit_logs (school_id, action, target_table, target_id, new_values)
          VALUES (${school}, 'insert', 'users', gen_random_uuid(), '"just-a-string"'::jsonb)
        `,
      );
      expect(scalar.code).toBe("23514");

      // The non-DML actions describe no row change and carry neither payload.
      const login = await append(
        database,
        { school },
        { actor, action: "login", targetTable: "users", oldValues: null, newValues: null },
      );
      expect(login.partition).toBe("app.audit_logs_y2026m07");

      // A system-initiated event has no actor. The composite FK is MATCH SIMPLE, so it is simply not
      // checked when actor_id is NULL -- while school_id stays NOT NULL and the tenant boundary holds.
      const system = await append(
        database,
        { school },
        { actor: null, action: "export", oldValues: null, newValues: null },
      );
      expect(system.id).toBeTruthy();

      // An actor from another school cannot be attributed an action in this one: the FK is composite.
      const otherSchool = await createSchool(database, "audit-payload-other");
      const foreignActor = await createUser(database, otherSchool, "foreign");
      const crossActor = await expectFailure(
        database,
        "studafy_app",
        { school },
        (tx) => tx`
          INSERT INTO app.audit_logs (school_id, actor_id, action, target_table, target_id, new_values)
          VALUES (${school}, ${foreignActor}, 'insert', 'users', gen_random_uuid(), '{}'::jsonb)
        `,
      );
      expect(crossActor.code).toBe("23503");
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "prunes to a single partition when the query is bounded in time, and scans all of them when it is not",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "audit-pruning");
      const actor = await createUser(database, school, "pruner");
      const noisy = await createUser(database, school, "pruner-noise");
      const target = "11111111-1111-4111-8111-111111111111";

      // Enough rows, and current statistics, for the planner to make a realistic choice. On an empty
      // table it would sequentially scan everything regardless of the indexes, and the plan would prove
      // nothing.
      //
      // The bulk of the traffic belongs to a *different* actor, because a fixture where every row shares
      // one actor makes actor_id perfectly unselective -- and the planner would then correctly ignore
      // idx_audit_logs_school_actor in favour of the narrower (school_id, created_at) index, proving the
      // opposite of what this test is for. A real audit log has many actors.
      await asUser(database, { school }, async (tx) => {
        await tx`
          INSERT INTO app.audit_logs (school_id, actor_id, action, target_table, target_id, new_values, created_at)
          SELECT ${school}, ${noisy}, 'insert', 'users', gen_random_uuid(), '{}'::jsonb,
                 '2026-07-01T00:00:00+00'::timestamptz + (series || ' minutes')::interval
          FROM generate_series(1, 2000) AS series
        `;
        // A handful of rows for the actor under investigation: selective, as it would be in production.
        await tx`
          INSERT INTO app.audit_logs (school_id, actor_id, action, target_table, target_id, new_values, created_at)
          SELECT ${school}, ${actor}, 'login', 'users', gen_random_uuid(), NULL,
                 '2026-07-02T00:00:00+00'::timestamptz + (series || ' hours')::interval
          FROM generate_series(1, 5) AS series
        `;
        await tx`
          INSERT INTO app.audit_logs (school_id, actor_id, action, target_table, target_id, old_values, new_values, created_at)
          VALUES (${school}, ${actor}, 'update', 'classes', ${target},
                  '{"name":"before"}'::jsonb, '{"name":"after"}'::jsonb, ${IN_JULY}::timestamptz)
        `;
      });
      await database.sql`ANALYZE app.audit_logs`;

      const planOf = async (where: string): Promise<string> => {
        const rows = await asUser(database, { school }, (tx) =>
          tx.unsafe(`
            EXPLAIN (FORMAT JSON)
            SELECT id, action, old_values, new_values, created_at
            FROM app.audit_logs
            WHERE school_id = '${school}'::uuid AND ${where}
            ORDER BY created_at DESC
            LIMIT 50
          `),
        );
        return JSON.stringify(rows);
      };

      const partitionsIn = (plan: string): string[] =>
        [...new Set(plan.match(/audit_logs_y\d{4}m\d{2}(?=\W)/g) ?? [])].sort();

      // A partition-local index does NOT inherit its parent's name -- PostgreSQL generates one from the
      // partition and column list (audit_logs_y2026m07_school_id_target_table_target_id_create_idx),
      // truncated to 63 characters. So the plan can never mention "idx_audit_logs_school_target"
      // literally; resolve the child index through pg_inherits, which is also what proves the index the
      // planner chose really is the clone of the parent index we intended.
      const childIndexOf = async (parentIndex: string, partition: string): Promise<string> => {
        const [row] = await database.sql<{ name: string }[]>`
          SELECT child.relname AS name
          FROM pg_inherits i
          JOIN pg_class child ON child.oid = i.inhrelid
          JOIN pg_class parent ON parent.oid = i.inhparent
          JOIN pg_namespace n ON n.oid = parent.relnamespace
          WHERE n.nspname = 'app'
            AND parent.relname = ${parentIndex}
            AND child.relname LIKE ${`${partition}%`}
        `;
        if (!row) throw new Error(`no partition-local index of ${parentIndex} on ${partition}`);
        return row.name;
      };

      // The intended audit query: a school, a target record, and a temporal bound. Partition pruning is
      // driven by created_at, so this reaches exactly one monthly partition...
      const pruned = await planOf(
        `target_table = 'classes' AND target_id = '${target}'::uuid
         AND created_at >= '2026-07-01T00:00:00+00'::timestamptz
         AND created_at <  '2026-08-01T00:00:00+00'::timestamptz`,
      );
      expect(partitionsIn(pruned)).toEqual(["audit_logs_y2026m07"]);
      // ...via the target-investigation index, not a sequential scan.
      expect(pruned).toContain(
        await childIndexOf("idx_audit_logs_school_target", "audit_logs_y2026m07"),
      );
      expect(pruned).not.toContain("Seq Scan");

      // The same query without a temporal bound cannot prune. It is still correct and still uses the
      // index, but it must now probe every monthly partition that exists -- which is why the audit
      // search API must always carry a time range. See docs/database/audit-logs-data-model.md.
      const unpruned = await planOf(`target_table = 'classes' AND target_id = '${target}'::uuid`);
      expect(partitionsIn(unpruned)).toEqual([...INITIAL_PARTITIONS].sort());

      // The actor path and the temporal-school path each use their own index.
      const byActor = await planOf(
        `actor_id = '${actor}'::uuid
         AND created_at >= '2026-07-01T00:00:00+00'::timestamptz
         AND created_at <  '2026-08-01T00:00:00+00'::timestamptz`,
      );
      expect(partitionsIn(byActor)).toEqual(["audit_logs_y2026m07"]);
      expect(byActor).toContain(
        await childIndexOf("idx_audit_logs_school_actor", "audit_logs_y2026m07"),
      );

      const bySchoolAndTime = await planOf(
        `created_at >= '2026-07-01T00:00:00+00'::timestamptz
         AND created_at <  '2026-08-01T00:00:00+00'::timestamptz`,
      );
      expect(partitionsIn(bySchoolAndTime)).toEqual(["audit_logs_y2026m07"]);
      expect(bySchoolAndTime).toContain(
        await childIndexOf("idx_audit_logs_school_created", "audit_logs_y2026m07"),
      );
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

integrationTest(
  "creates future partitions idempotently, with the same append-only grants and forced policy",
  async () => {
    const database = await migratedDatabase();
    try {
      const env = runnerEnv(database.url, repositoryMigrations);

      // 24 months ahead reaches well beyond 000018's fixed initial range.
      const created = await ensureAuditLogPartitions(24, { env, log: () => undefined });
      expect(created.length).toBeGreaterThan(0);
      for (const name of created) expect(name).toMatch(/^audit_logs_y\d{4}m\d{2}$/);

      // Idempotent: a second run creates nothing and does not fail.
      const again = await ensureAuditLogPartitions(24, { env, log: () => undefined });
      expect(again).toEqual([]);

      // Every partition the job made carries the same security posture as the ones the migration made.
      // This is the assertion that matters operationally: the partitions serving traffic a year from now
      // are created by this command, not by a reviewed migration.
      const posture = await database.sql<
        {
          name: string;
          owner: string;
          rls: boolean;
          forced: boolean;
          policy: string;
          app_update: boolean;
          app_delete: boolean;
          app_insert: boolean;
          app_select: boolean;
          public_any: boolean;
          indexes: string;
        }[]
      >`
        SELECT c.relname AS name,
               pg_get_userbyid(c.relowner) AS owner,
               c.relrowsecurity AS rls,
               c.relforcerowsecurity AS forced,
               (SELECT count(*)::text FROM pg_policy p
                 WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy,
               has_table_privilege('studafy_app', c.oid, 'UPDATE') AS app_update,
               has_table_privilege('studafy_app', c.oid, 'DELETE') AS app_delete,
               has_table_privilege('studafy_app', c.oid, 'INSERT') AS app_insert,
               has_table_privilege('studafy_app', c.oid, 'SELECT') AS app_select,
               has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS public_any,
               (SELECT count(*)::text FROM pg_index i WHERE i.indrelid = c.oid) AS indexes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY(${created})
        ORDER BY c.relname
      `;
      expect(posture).toHaveLength(created.length);
      for (const partition of posture) {
        expect(partition).toMatchObject({
          owner: "studafy_admin",
          rls: true,
          forced: true,
          policy: "1",
          app_select: true,
          app_insert: true,
          app_update: false,
          app_delete: false,
          public_any: false,
          indexes: String(INDEXES_PER_PARTITION),
        });
      }

      // Bounds are half-open UTC months, and contiguous.
      const bounds = await database.sql<{ name: string; bounds: string }[]>`
        SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bounds
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY(${created})
        ORDER BY c.relname
      `;
      for (const partition of bounds) {
        expect(partition.bounds).toMatch(
          /^FOR VALUES FROM \('.+ 00:00:00\+00'\) TO \('.+ 00:00:00\+00'\)$/,
        );
      }
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);
