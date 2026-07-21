import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

const IDENTITY_TABLES = [
  "users",
  "user_roles",
  "oauth_identities",
  "invitations",
  "refresh_tokens",
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

// Runs a single statement as `role` (optionally under a tenant GUC) and asserts it is rejected.
//
// `actor` sets app.user_id alongside app.school_id. Required for any statement touching
// app.refresh_tokens since 000029: its RESTRICTIVE refresh_tokens_owner policy calls
// app.current_user_id(), which raises 42704 on an unset GUC. Without it a statement would be
// "denied" because the GUC was missing rather than because of the constraint under test, and this
// helper cannot tell those apart — it catches WHEN OTHERS.
async function expectRoleDenied(
  database: Database,
  role: Role,
  statement: string,
  context?: string,
  actor?: string,
): Promise<void> {
  await asRole(database, role, async (tx) => {
    if (context !== undefined) await tx`SELECT set_config('app.school_id', ${context}, true)`;
    if (actor !== undefined) await tx`SELECT set_config('app.user_id', ${actor}, true)`;
    await tx.unsafe(`
      DO $expected_database_error$
      DECLARE
        statement_failed boolean := false;
      BEGIN
        BEGIN
          EXECUTE $tested_statement$${statement}$tested_statement$;
        EXCEPTION
          WHEN OTHERS THEN statement_failed := true;
        END;
        IF NOT statement_failed THEN
          RAISE EXCEPTION 'expected database statement unexpectedly succeeded';
        END IF;
      END
      $expected_database_error$
    `);
  });
}

// Two schools in the same country/currency provide the two tenants every isolation test needs.
async function createSchools(database: Database): Promise<{ schoolA: string; schoolB: string }> {
  const [references] = await database.sql<{ country_id: string; currency_id: string }[]>`
    SELECT
      (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country_id,
      (SELECT id FROM app.currencies WHERE code = 'USD') AS currency_id
  `;
  if (!references) throw new Error("US and USD reference rows are required");

  return asRole(database, "studafy_admin", async (tx) => {
    const schools = await tx<{ id: string; slug: string }[]>`
      INSERT INTO app.schools (slug, name, country_id, default_currency_id)
      VALUES
        ('identity-school-a', 'Identity School A', ${references.country_id}, ${references.currency_id}),
        ('identity-school-b', 'Identity School B', ${references.country_id}, ${references.currency_id})
      RETURNING id, slug
    `;
    return {
      schoolA: schools.find((school) => school.slug === "identity-school-a")!.id,
      schoolB: schools.find((school) => school.slug === "identity-school-b")!.id,
    };
  });
}

// Inserts a user under its own tenant context (RLS is already forced) and returns its id.
async function createUser(
  database: Database,
  schoolId: string,
  normalizedEmail: string,
): Promise<string> {
  return asRole(database, "studafy_app", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email)
      VALUES (${schoolId}, ${normalizedEmail}, ${normalizedEmail})
      RETURNING id
    `;
    return row!.id;
  });
}

integrationTest(
  "provisions five forced-RLS tenant tables owned administratively",
  async () => {
    const database = await migratedDatabase();
    try {
      const tables = await database.sql<
        { name: string; owner: string; rls_enabled: boolean; rls_forced: boolean }[]
      >`
        SELECT
          c.relname AS name,
          pg_get_userbyid(c.relowner) AS owner,
          c.relrowsecurity AS rls_enabled,
          c.relforcerowsecurity AS rls_forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY(${IDENTITY_TABLES as unknown as string[]})
        ORDER BY c.relname
      `;
      expect(tables.map((table) => table.name)).toEqual([...IDENTITY_TABLES].sort());
      expect(
        tables.every(
          (table) => table.owner === "studafy_admin" && table.rls_enabled && table.rls_forced,
        ),
      ).toBe(true);

      // Every table carries exactly the canonical tenant_isolation policy (permissive, FOR ALL,
      // PUBLIC) with school_id-based USING and WITH CHECK expressions.
      const policies = await database.sql<
        {
          table_name: string;
          name: string;
          permissive: boolean;
          command: string;
          roles: number[];
          using_expression: string;
          check_expression: string;
        }[]
      >`
        SELECT
          c.relname AS table_name,
          p.polname AS name,
          p.polpermissive AS permissive,
          p.polcmd AS command,
          p.polroles::integer[] AS roles,
          pg_get_expr(p.polqual, p.polrelid) AS using_expression,
          pg_get_expr(p.polwithcheck, p.polrelid) AS check_expression
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY(${IDENTITY_TABLES as unknown as string[]})
        ORDER BY c.relname
      `;
      const tenantPolicies = policies.filter(
        (policy) => policy.permissive && policy.name === "tenant_isolation",
      );
      expect(tenantPolicies.map((policy) => policy.table_name)).toEqual(
        [...IDENTITY_TABLES].sort(),
      );
      for (const policy of tenantPolicies) {
        expect(policy.command).toBe("*");
        expect(policy.roles).toEqual([0]);
        expect(policy.using_expression).toContain("current_setting('app.school_id'::text)");
        expect(policy.check_expression).toContain("current_setting('app.school_id'::text)");
        expect(policy.using_expression).toContain("school_id");
        expect(policy.check_expression).toContain("school_id");
      }

      // A permissive policy widens access rather than narrowing it, so every one that is not
      // tenant_isolation is pinned by shape here instead of being waved through by the filter above.
      // Two exist, both SECURITY DEFINER read seams that let a global lookup see a single row while the
      // table stays FORCE ROW LEVEL SECURITY:
      //   - invitation_token_verification (000031), behind GET /api/auth/invitations/{token}/verify.
      //   - oauth_identity_login_lookup (000034), behind POST /api/auth/login/oauth — the returning-user
      //     login resolves the globally unique (provider, subject) pair before any tenant is known.
      // What keeps each seam closed is the role and the predicate: both are granted to studafy_admin
      // only — never PUBLIC, and never studafy_app, which is the role ordinary request handlers run as —
      // and each USING clause pins the lookup to the exact value(s) the function places in a
      // transaction-local GUC. db/policies/rls-coverage.ts carves out the same policies for the CLI
      // audit; the two must agree.
      const seamPolicies = policies.filter(
        (policy) => policy.permissive && policy.name !== "tenant_isolation",
      );
      expect(seamPolicies.map((policy) => `${policy.table_name}.${policy.name}`)).toEqual([
        "invitations.invitation_token_verification",
        "oauth_identities.oauth_identity_login_lookup",
      ]);
      const [adminRole] = await database.sql<{ oid: number }[]>`
        SELECT oid::integer AS oid FROM pg_roles WHERE rolname = 'studafy_admin'
      `;
      for (const policy of seamPolicies) {
        // 'r' is SELECT — the seam can read one row, never write.
        expect(policy.command).toBe("r");
        expect(policy.roles).toEqual([adminRole!.oid]);
        expect(policy.check_expression).toBeNull();
      }
      // Each seam pins its lookup to the GUC-carried value(s) its SECURITY DEFINER function sets, so the
      // permissive grant can never reach beyond that one candidate row.
      const invitationSeam = seamPolicies.find(
        (policy) => policy.name === "invitation_token_verification",
      );
      expect(invitationSeam?.using_expression).toContain("app.invitation_token_hash");
      expect(invitationSeam?.using_expression).toContain("token_hash");
      const oauthSeam = seamPolicies.find(
        (policy) => policy.name === "oauth_identity_login_lookup",
      );
      expect(oauthSeam?.using_expression).toContain("app.oauth_login_provider");
      expect(oauthSeam?.using_expression).toContain("app.oauth_login_subject");

      // Restrictive policies AND with the permissive one, so they can only ever narrow access —
      // which is why they are filtered out above rather than folded into the same assertion. Exactly
      // one exists here: refresh_tokens_owner (000029), fencing token rows to their owning user on
      // top of the tenant fence. It names studafy_app rather than PUBLIC, so a studafy_admin-owned
      // maintenance path keeps its reach; that is the same shape 000017 uses for user_devices.
      const restrictivePolicies = policies.filter((policy) => !policy.permissive);
      expect(restrictivePolicies.map((policy) => `${policy.table_name}.${policy.name}`)).toEqual([
        "refresh_tokens.refresh_tokens_owner",
      ]);
      for (const policy of restrictivePolicies) {
        expect(policy.command).toBe("*");
        // Not PUBLIC (oid 0) — a restrictive policy applies only to the roles it names.
        expect(policy.roles).not.toEqual([0]);
        expect(policy.using_expression).toContain("current_user_id()");
        expect(policy.check_expression).toContain("current_user_id()");
      }

      // studafy_app owns none of the identity tables.
      const [ownership] = await database.sql<{ app_owned: string }[]>`
        SELECT count(*)::text AS app_owned
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app'
          AND c.relname = ANY(${IDENTITY_TABLES as unknown as string[]})
          AND c.relowner = 'studafy_app'::regrole
      `;
      expect(ownership?.app_owned).toBe("0");

      // Hash-only token storage: the only token-shaped columns are token_hash, and they are bytea.
      const tokenColumns = await database.sql<
        { table_name: string; column_name: string; data_type: string }[]
      >`
        SELECT table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'app'
          AND table_name = ANY(${IDENTITY_TABLES as unknown as string[]})
          AND (column_name ~ 'token' OR column_name ~ 'secret' OR column_name ~ 'raw')
        ORDER BY table_name, column_name
      `;
      expect(Array.from(tokenColumns)).toEqual([
        { table_name: "invitations", column_name: "token_hash", data_type: "bytea" },
        { table_name: "refresh_tokens", column_name: "parent_token_id", data_type: "uuid" },
        { table_name: "refresh_tokens", column_name: "replaced_by_token_id", data_type: "uuid" },
        { table_name: "refresh_tokens", column_name: "token_hash", data_type: "bytea" },
      ]);

      // No JSONB is used for relational identity/role data.
      const [jsonb] = await database.sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM information_schema.columns
        WHERE table_schema = 'app'
          AND table_name = ANY(${IDENTITY_TABLES as unknown as string[]})
          AND data_type IN ('json', 'jsonb')
      `;
      expect(jsonb?.count).toBe("0");
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "enforces user, role, and oauth identity integrity across tenants",
  async () => {
    const database = await migratedDatabase();
    try {
      const { schoolA, schoolB } = await createSchools(database);
      const userA = await createUser(database, schoolA, "person@example.com");
      // The same normalized email may exist in a different school.
      const userB = await createUser(database, schoolB, "person@example.com");
      expect(userA).not.toBe(userB);

      // Duplicate (school_id, normalized_email) within a school is rejected.
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.users (school_id, email, normalized_email)
         VALUES ('${schoolA}', 'person@example.com', 'person@example.com')`,
        schoolA,
      );
      // Invalid status is rejected by the enum.
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.users (school_id, email, normalized_email, status)
         VALUES ('${schoolA}', 'other@example.com', 'other@example.com', 'bogus')`,
        schoolA,
      );
      // A non-lowercase normalized_email violates the canonical-form check.
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.users (school_id, email, normalized_email)
         VALUES ('${schoolA}', 'Mixed@Example.com', 'Mixed@Example.com')`,
        schoolA,
      );

      // Role assignment: valid succeeds, duplicate and invalid role fail.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`INSERT INTO app.user_roles (school_id, user_id, role) VALUES (${schoolA}, ${userA}, 'INSTRUCTOR')`;
      });
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.user_roles (school_id, user_id, role) VALUES ('${schoolA}', '${userA}', 'INSTRUCTOR')`,
        schoolA,
      );
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.user_roles (school_id, user_id, role) VALUES ('${schoolA}', '${userA}', 'WIZARD')`,
        schoolA,
      );
      // Cross-school assignment: referencing school B's user under school A's context fails the
      // composite foreign key (user_id, school_id) -> users(id, school_id).
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.user_roles (school_id, user_id, role) VALUES ('${schoolA}', '${userB}', 'STUDENT')`,
        schoolA,
      );

      // OAuth identities: (provider, subject) is globally unique across all tenants.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`
          INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
          VALUES (${schoolA}, ${userA}, 'google', 'sub-123')
        `;
      });
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
         VALUES ('${schoolB}', '${userB}', 'google', 'sub-123')`,
        schoolB,
      );
      // Empty provider and empty subject are rejected.
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
         VALUES ('${schoolA}', '${userA}', '', 'sub-x')`,
        schoolA,
      );
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
         VALUES ('${schoolA}', '${userA}', 'google', '')`,
        schoolA,
      );
      // Cross-school user linkage fails the composite foreign key.
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
         VALUES ('${schoolA}', '${userB}', 'github', 'sub-777')`,
        schoolA,
      );
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "stores tokens hash-only and enforces invitation and refresh lifecycle",
  async () => {
    const database = await migratedDatabase();
    try {
      const { schoolA } = await createSchools(database);
      const userA = await createUser(database, schoolA, "inviter@example.com");

      // Invitations: a valid active invitation succeeds.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`
          INSERT INTO app.invitations
            (school_id, email, normalized_email, role, token_hash, invited_by_user_id, expires_at)
          VALUES
            (${schoolA}, 'invitee@example.com', 'invitee@example.com', 'STUDENT',
             digest('invite-token-1', 'sha256'), ${userA}, CURRENT_TIMESTAMP + interval '7 days')
        `;
      });
      // Duplicate token hash is rejected.
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.invitations (school_id, email, normalized_email, role, token_hash, expires_at)
         VALUES ('${schoolA}', 'a@example.com', 'a@example.com', 'STUDENT',
                 digest('invite-token-1', 'sha256'), CURRENT_TIMESTAMP + interval '7 days')`,
        schoolA,
      );
      // A 16-byte (md5) digest violates the 32-byte hash length check.
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.invitations (school_id, email, normalized_email, role, token_hash, expires_at)
         VALUES ('${schoolA}', 'b@example.com', 'b@example.com', 'STUDENT',
                 digest('short', 'md5'), CURRENT_TIMESTAMP + interval '7 days')`,
        schoolA,
      );
      // expires_at must be after created_at.
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.invitations (school_id, email, normalized_email, role, token_hash, expires_at)
         VALUES ('${schoolA}', 'c@example.com', 'c@example.com', 'STUDENT',
                 digest('invite-token-c', 'sha256'), CURRENT_TIMESTAMP - interval '1 day')`,
        schoolA,
      );
      // An invitation cannot be both revoked and consumed.
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.invitations
           (school_id, email, normalized_email, role, token_hash, expires_at, revoked_at, consumed_at)
         VALUES ('${schoolA}', 'd@example.com', 'd@example.com', 'STUDENT',
                 digest('invite-token-d', 'sha256'), CURRENT_TIMESTAMP + interval '1 day',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        schoolA,
      );
      // Only one active invitation per (school, normalized_email, role): the second active row for
      // the same triple is rejected, but a new one is allowed once the first is revoked.
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.invitations (school_id, email, normalized_email, role, token_hash, expires_at)
         VALUES ('${schoolA}', 'invitee@example.com', 'invitee@example.com', 'STUDENT',
                 digest('invite-token-2', 'sha256'), CURRENT_TIMESTAMP + interval '7 days')`,
        schoolA,
      );
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        const revoked = await tx`
          UPDATE app.invitations SET revoked_at = CURRENT_TIMESTAMP
          WHERE school_id = ${schoolA} AND normalized_email = 'invitee@example.com'
        `;
        expect(revoked.count).toBe(1);
        await tx`
          INSERT INTO app.invitations (school_id, email, normalized_email, role, token_hash, expires_at)
          VALUES (${schoolA}, 'invitee@example.com', 'invitee@example.com', 'STUDENT',
                  digest('invite-token-3', 'sha256'), CURRENT_TIMESTAMP + interval '7 days')
        `;
      });

      // Refresh tokens: a valid record succeeds; duplicate hash, bad lifecycle, and self-reference
      // are rejected.
      const familyId = crypto.randomUUID();
      const firstTokenId = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`SELECT set_config('app.user_id', ${userA}, true)`;
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO app.refresh_tokens
            (school_id, user_id, token_hash, channel, family_id, expires_at, device_name)
          VALUES
            (${schoolA}, ${userA}, digest('refresh-token-1', 'sha256'), 'mobile',
             ${familyId}, CURRENT_TIMESTAMP + interval '30 days', 'Pixel 8')
          RETURNING id
        `;
        return row!.id;
      });
      // Duplicate token_hash. Every other column is valid, so uq_refresh_tokens_token_hash is the
      // only thing left that can reject this.
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.refresh_tokens
           (school_id, user_id, token_hash, channel, family_id, expires_at)
         VALUES ('${schoolA}', '${userA}', digest('refresh-token-1', 'sha256'),
                 'mobile', '${familyId}', CURRENT_TIMESTAMP + interval '30 days')`,
        schoolA,
        userA,
      );
      // expires_at before issued_at.
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.refresh_tokens
           (school_id, user_id, token_hash, channel, family_id, expires_at)
         VALUES ('${schoolA}', '${userA}', digest('refresh-token-2', 'sha256'),
                 'mobile', '${familyId}', CURRENT_TIMESTAMP - interval '1 day')`,
        schoolA,
        userA,
      );
      // replaced_by_token_id cannot equal the row's own id.
      await expectRoleDenied(
        database,
        "studafy_app",
        `UPDATE app.refresh_tokens SET replaced_by_token_id = id
         WHERE id = '${firstTokenId}'`,
        schoolA,
        userA,
      );

      // A rotated child token in the same family links back to its parent.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`SELECT set_config('app.user_id', ${userA}, true)`;
        await tx`
          INSERT INTO app.refresh_tokens
            (school_id, user_id, token_hash, channel, family_id, parent_token_id, expires_at)
          VALUES
            (${schoolA}, ${userA}, digest('refresh-token-2', 'sha256'), 'mobile',
             ${familyId}, ${firstTokenId}, CURRENT_TIMESTAMP + interval '30 days')
        `;
        const family = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.refresh_tokens
          WHERE school_id = ${schoolA} AND family_id = ${familyId}
        `;
        expect(family[0]?.count).toBe("2");
      });
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "fails closed and isolates every tenant read and write path",
  async () => {
    const database = await migratedDatabase();
    try {
      const { schoolA, schoolB } = await createSchools(database);
      const userA = await createUser(database, schoolA, "reader@example.com");
      await createUser(database, schoolB, "reader@example.com");

      // Missing GUC and invalid GUC fail closed on every table.
      for (const table of IDENTITY_TABLES) {
        await expectRoleDenied(database, "studafy_app", `SELECT * FROM app.${table}`);
        for (const context of ["", "not-a-uuid"]) {
          await expectRoleDenied(database, "studafy_app", `SELECT * FROM app.${table}`, context);
        }
      }

      // A tenant sees only its own users.
      const visible = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        return tx<{ school_id: string }[]>`SELECT DISTINCT school_id FROM app.users`;
      });
      expect(Array.from(visible)).toEqual([{ school_id: schoolA }]);

      // Cross-tenant insert (WITH CHECK), cross-tenant re-parent (UPDATE), and cross-tenant delete
      // are all denied or silently affect zero rows.
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.users (school_id, email, normalized_email)
         VALUES ('${schoolB}', 'x@example.com', 'x@example.com')`,
        schoolA,
      );
      await expectRoleDenied(
        database,
        "studafy_app",
        `UPDATE app.users SET school_id = '${schoolB}' WHERE id = '${userA}'`,
        schoolA,
      );
      const hidden = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        const update =
          await tx`UPDATE app.users SET display_name = 'hijacked' WHERE school_id = ${schoolB}`;
        const del = await tx`DELETE FROM app.users WHERE school_id = ${schoolB}`;
        return { update: update.count, del: del.count };
      });
      expect(hidden).toEqual({ update: 0, del: 0 });

      // The runtime role cannot weaken RLS or execute the administrative helper.
      for (const ddl of [
        "ALTER TABLE app.users DISABLE ROW LEVEL SECURITY",
        "ALTER TABLE app.users NO FORCE ROW LEVEL SECURITY",
        "DROP POLICY tenant_isolation ON app.users",
        "SELECT app.apply_tenant_isolation('app', 'users')",
      ]) {
        await expectRoleDenied(database, "studafy_app", ddl, schoolA);
      }
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "keeps runtime grants least-privilege and indexes deliberate",
  async () => {
    const database = await migratedDatabase();
    try {
      const { schoolA } = await createSchools(database);
      const userA = await createUser(database, schoolA, "planner@example.com");

      // Grant matrix: studafy_app has full CRUD, PUBLIC has nothing.
      for (const table of IDENTITY_TABLES) {
        const [privileges] = await database.sql.unsafe<
          {
            app_select: boolean;
            app_insert: boolean;
            app_update: boolean;
            app_delete: boolean;
            public_select: boolean;
          }[]
        >(`
          SELECT
            has_table_privilege('studafy_app', 'app.${table}', 'SELECT') AS app_select,
            has_table_privilege('studafy_app', 'app.${table}', 'INSERT') AS app_insert,
            has_table_privilege('studafy_app', 'app.${table}', 'UPDATE') AS app_update,
            has_table_privilege('studafy_app', 'app.${table}', 'DELETE') AS app_delete,
            has_table_privilege('public', 'app.${table}', 'SELECT') AS public_select
        `);
        expect(privileges).toEqual({
          app_select: true,
          app_insert: true,
          app_update: true,
          app_delete: true,
          public_select: false,
        });
      }

      // No duplicate indexes on any identity table.
      const [duplicates] = await database.sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM (
          SELECT indrelid, indkey::text, indexprs::text, indpred::text
          FROM pg_index
          WHERE indrelid IN (
            SELECT c.oid FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'app' AND c.relname = ANY(${IDENTITY_TABLES as unknown as string[]})
          )
          GROUP BY indrelid, indkey::text, indexprs::text, indpred::text
          HAVING count(*) > 1
        ) d
      `;
      expect(duplicates?.count).toBe("0");

      const supportingIndexes = await database.sql<{ indexname: string }[]>`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'app'
          AND indexname LIKE 'idx_%'
          AND tablename = ANY(${IDENTITY_TABLES as unknown as string[]})
        ORDER BY indexname
      `;
      expect(supportingIndexes.map((index) => index.indexname)).toEqual([
        "idx_invitations_school_invited_by",
        "idx_oauth_identities_school_user",
        // Added by 000029 for ST-071: per-device session enumeration and termination, and the
        // partial index backing the live-session list.
        "idx_refresh_tokens_school_device",
        "idx_refresh_tokens_school_family",
        "idx_refresh_tokens_school_parent",
        "idx_refresh_tokens_school_replaced_by",
        "idx_refresh_tokens_school_user",
        "idx_refresh_tokens_school_user_active",
        // Added by 000030 for ST-072: batch revocation with INCLUDE for access_jti/access_expires_at.
        "idx_refresh_tokens_school_user_device_active",
      ]);

      // Seed representative refresh-token families so the planner can distinguish the selective
      // family index from the user index instead of choosing arbitrarily on a one-row fixture.
      const familyId = crypto.randomUUID();
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`SELECT set_config('app.user_id', ${userA}, true)`;
        await tx`
          INSERT INTO app.refresh_tokens
            (school_id, user_id, token_hash, channel, family_id, expires_at)
          VALUES (${schoolA}, ${userA}, digest('rt-plan', 'sha256'), 'web',
                  ${familyId}, CURRENT_TIMESTAMP + interval '30 days')
        `;
        await tx`
          INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
          VALUES (${schoolA}, ${userA}, 'google', 'plan-sub')
        `;
      });

      // Filler rows, so the planner can tell the selective family index from the user index instead
      // of picking arbitrarily on a one-row fixture.
      await asRole(database, "studafy_admin", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`
          INSERT INTO app.refresh_tokens
            (school_id, user_id, token_hash, channel, family_id, expires_at)
          SELECT
            ${schoolA},
            ${userA},
            digest('rt-plan-filler-' || number, 'sha256'),
            'web',
            gen_random_uuid(),
            CURRENT_TIMESTAMP + interval '30 days'
          FROM generate_series(1, 250) AS series(number)
        `;
      });

      await asRole(database, "studafy_admin", (tx) =>
        tx.unsafe("ANALYZE app.refresh_tokens").then(() => undefined),
      );

      // Intended index usage: token-hash lookup, OAuth callback lookup, and family revocation.
      const plans = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`SELECT set_config('app.user_id', ${userA}, true)`;
        await tx.unsafe("SET LOCAL enable_seqscan = off");
        const tokenPlan = await tx.unsafe(`
          EXPLAIN (FORMAT JSON)
          SELECT id FROM app.refresh_tokens WHERE token_hash = digest('rt-plan', 'sha256')
        `);
        const oauthPlan = await tx.unsafe(`
          EXPLAIN (FORMAT JSON)
          SELECT user_id FROM app.oauth_identities WHERE provider = 'google' AND subject = 'plan-sub'
        `);
        const familyPlan = await tx.unsafe(`
          EXPLAIN (FORMAT JSON)
          SELECT id FROM app.refresh_tokens WHERE school_id = '${schoolA}' AND family_id = '${familyId}'
        `);
        return { tokenPlan, oauthPlan, familyPlan };
      });
      expect(JSON.stringify(plans.tokenPlan)).toContain("uq_refresh_tokens_token_hash");
      expect(JSON.stringify(plans.oauthPlan)).toContain("uq_oauth_identities_provider_subject");
      expect(JSON.stringify(plans.familyPlan)).toContain("idx_refresh_tokens_school_family");

      // The runtime role cannot create indexes on tenant tables.
      await expectRoleDenied(
        database,
        "studafy_app",
        "CREATE INDEX forbidden_runtime_index ON app.users (display_name)",
        schoolA,
      );
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

/**
 * ST-071 session objects: the channel enum and the per-user fence.
 *
 * Kept separate from the schema test above because these assert a security boundary rather than a
 * shape. The fence is the point: app.refresh_tokens shipped with tenant isolation only, so any
 * authenticated session in a school could read and revoke every other user's sessions in that
 * school. 000029 adds a RESTRICTIVE policy on top, and restrictive policies AND with the permissive
 * one, so a row is reachable only when both the school and the user match.
 *
 * The fence is also why the wire token carries the user id: app.current_user_id() raises on an unset
 * GUC rather than matching nothing, so the owner has to be known before the row can be read. The
 * last assertion here pins that failure mode, because a fence that failed *open* on a missing GUC
 * would be worse than no fence at all.
 */
integrationTest(
  "installs the ST-071 session objects with a per-user fence that fails closed",
  async () => {
    const database = await migratedDatabase();
    try {
      const { schoolA } = await createSchools(database);
      const userA = await createUser(database, schoolA, "owner@example.com");
      const userB = await createUser(database, schoolA, "other@example.com");

      // app.auth_channel mirrors AUTH_CHANNELS in apps/api/src/modules/auth/channels.ts. Label order
      // is asserted, not just membership, so the two cannot drift.
      const [channelEnum] = await database.sql<{ values: string[] }[]>`
        SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE n.nspname = 'app' AND t.typname = 'auth_channel'
      `;
      expect(channelEnum?.values).toEqual(["web", "mobile", "api"]);

      // FORCE survived the migration. 000029 clears it to run its DDL and restores it at the end;
      // if that restore were ever dropped, studafy_admin would be exempt from tenant_isolation on
      // this table permanently and nothing in the application would misbehave to reveal it.
      const [flags] = await database.sql<{ rls: boolean; forced: boolean }[]>`
        SELECT relrowsecurity AS rls, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = 'app.refresh_tokens'::regclass
      `;
      expect(flags).toEqual({ rls: true, forced: true });

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`SELECT set_config('app.user_id', ${userA}, true)`;
        await tx`
          INSERT INTO app.refresh_tokens
            (school_id, user_id, token_hash, channel, family_id, expires_at)
          VALUES (${schoolA}, ${userA}, digest('owned-token', 'sha256'), 'web',
                  ${crypto.randomUUID()}, CURRENT_TIMESTAMP + interval '30 days')
        `;
      });

      // userB is in the same school, so tenant_isolation alone would have let this through.
      const seenByOther = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`SELECT set_config('app.user_id', ${userB}, true)`;
        return tx<{ count: string }[]>`SELECT count(*)::text AS count FROM app.refresh_tokens`;
      });
      expect(seenByOther[0]?.count).toBe("0");

      // And the owner still sees their own.
      const seenByOwner = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`SELECT set_config('app.user_id', ${userA}, true)`;
        return tx<{ count: string }[]>`SELECT count(*)::text AS count FROM app.refresh_tokens`;
      });
      expect(seenByOwner[0]?.count).toBe("1");

      // Fails closed, not open, when app.user_id is missing: app.current_user_id() raises 42704 on an
      // unset GUC. Every withTenantTx call touching this table must pass a userId, and this is what
      // makes forgetting loud instead of silently returning somebody else's rows.
      await expectRoleDenied(
        database,
        "studafy_app",
        "SELECT count(*) FROM app.refresh_tokens",
        schoolA,
      );
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);
