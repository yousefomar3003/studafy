import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
const TENANT_TABLES = ["notifications", "notification_preferences", "user_devices"] as const;

// Every notification type on every channel. The trigger seeds the full matrix on activation.
const NOTIFICATION_TYPES = [
  "ASSIGNMENT_DUE_SOON",
  "GRADE_POSTED",
  "ENROLLMENT_APPROVED",
  "COURSE_PUBLISHED",
  "DISCUSSION_REPLY",
  "STUDY_GROUP_INVITE",
  "CERTIFICATE_ISSUED",
  "SUPPORT_MESSAGE",
  // ST-110. Appended by 000057 via ALTER TYPE ... ADD VALUE, so it sorts after the original eight in
  // pg_enum order — which is what the enum assertion below compares against. DEFAULT_PREFERENCES is
  // derived from this list, so the activation trigger's seeded matrix grows with it.
  "ATTENDANCE_ALERT",
  // ST-143. Appended by 000082, same mechanism. The one type MANDATORY_NOTIFICATION_TYPES holds —
  // the trigger always seeds enabled = true, which is also the only value
  // ck_notification_preferences_mandatory_enabled (000083) permits for it.
  "ADMIN_ANNOUNCEMENT",
  // ST-151. Appended by 000088, same mechanism. Raised by the file-scan worker when a confirmed
  // material is quarantined (ClamAV verdict) or when its scan cannot complete; the trigger seeds
  // the full matrix for them like every other type, so they sort after ADMIN_ANNOUNCEMENT.
  "MATERIAL_SCAN_QUARANTINED",
  "MATERIAL_SCAN_FAILED",
] as const;
const NOTIFICATION_CHANNELS = ["in_app", "email", "push"] as const;
const DEFAULT_PREFERENCES = NOTIFICATION_TYPES.length * NOTIFICATION_CHANNELS.length;

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

// Both GUCs, transaction-local. Unlike the other suites this model needs app.user_id as well as
// app.school_id, because the restrictive policies read it.
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

async function expectDenied(
  database: Database,
  statement: string,
  context?: Context,
  role: Role = "studafy_app",
): Promise<void> {
  await asRole(database, role, async (tx) => {
    if (context !== undefined) {
      await tx`SELECT set_config('app.school_id', ${context.school}, true)`;
      if (context.user !== undefined)
        await tx`SELECT set_config('app.user_id', ${context.user}, true)`;
    }
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

async function createUser(
  database: Database,
  school: string,
  suffix: string,
  status: "invited" | "active" = "active",
): Promise<string> {
  return asUser(database, { school }, async (tx) => {
    const email = `notify-${suffix}@example.test`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, ${email}, ${email}, ${status}::app.user_status)
      RETURNING id
    `;
    return user!.id;
  });
}

// Preferences are invisible to studafy_app unless they belong to the acting user, so counting
// another user's rows has to happen as studafy_admin (which the restrictive policy does not name).
async function countPreferences(database: Database, school: string, user: string): Promise<number> {
  const rows = await asUser(
    database,
    { school },
    (tx) =>
      tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM app.notification_preferences WHERE user_id = ${user}
      `,
    "studafy_admin",
  );
  return Number(rows[0]!.count);
}

integrationTest(
  "installs the exact notification schema, ownership, grants, and forced policies",
  async () => {
    const database = await migratedDatabase();
    try {
      const enums = await database.sql<{ name: string; values: string[] }[]>`
        SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE n.nspname = 'app'
          AND t.typname IN ('notification_type', 'notification_channel', 'device_platform')
        GROUP BY t.typname
        ORDER BY t.typname
      `;
      // Label order is asserted, not just membership: app.notification_type must stay in lockstep
      // with NOTIFICATION_TYPES in packages/constants/src/notifications.ts.
      expect([...enums]).toEqual([
        { name: "device_platform", values: ["ios", "android", "web"] },
        { name: "notification_channel", values: [...NOTIFICATION_CHANNELS] },
        { name: "notification_type", values: [...NOTIFICATION_TYPES] },
      ]);

      const tables = await database.sql<
        {
          name: string;
          owner: string;
          rls: boolean;
          forced: boolean;
          app_crud: boolean;
          public_access: boolean;
        }[]
      >`
        SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
          c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
          has_table_privilege('studafy_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS app_crud,
          has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS public_access
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY(${TENANT_TABLES as unknown as string[]})
        ORDER BY c.relname
      `;
      expect(tables.map((row) => row.name)).toEqual([...TENANT_TABLES].sort());
      expect(
        tables.every(
          (row) =>
            row.owner === "studafy_admin" &&
            row.rls &&
            row.forced &&
            row.app_crud &&
            !row.public_access,
        ),
      ).toBe(true);

      // One permissive tenant_isolation policy per table, plus the restrictive user-isolation
      // policies. Notifications deliberately has no restrictive INSERT policy: senders address rows
      // to other users.
      const policies = await database.sql<
        {
          table_name: string;
          name: string;
          permissive: boolean;
          command: string;
          using_expression: string | null;
          check_expression: string | null;
          roles: string[];
        }[]
      >`
        SELECT c.relname AS table_name, p.polname AS name, p.polpermissive AS permissive,
          p.polcmd::text AS command,
          pg_get_expr(p.polqual, p.polrelid) AS using_expression,
          pg_get_expr(p.polwithcheck, p.polrelid) AS check_expression,
          array(SELECT pg_get_userbyid(unnest(p.polroles)))::text[] AS roles
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY(${TENANT_TABLES as unknown as string[]})
        ORDER BY c.relname, p.polname
      `;
      expect(policies.map((policy) => [policy.table_name, policy.name, policy.command])).toEqual([
        ["notification_preferences", "notification_preferences_owner", "*"],
        ["notification_preferences", "tenant_isolation", "*"],
        ["notifications", "notifications_owner_delete", "d"],
        ["notifications", "notifications_owner_select", "r"],
        ["notifications", "notifications_owner_update", "w"],
        ["notifications", "tenant_isolation", "*"],
        ["user_devices", "tenant_isolation", "*"],
        ["user_devices", "user_devices_owner", "*"],
      ]);

      const tenantPolicies = policies.filter((policy) => policy.name === "tenant_isolation");
      expect(tenantPolicies).toHaveLength(3);
      for (const policy of tenantPolicies) {
        expect(policy.permissive).toBe(true);
        expect(policy.using_expression).toContain("current_setting('app.school_id'::text)");
        expect(policy.check_expression).toContain("current_setting('app.school_id'::text)");
      }

      // The user-isolation policies are restrictive (they AND with tenant_isolation, they do not
      // broaden it) and are scoped to studafy_app so the SECURITY DEFINER functions keep their
      // narrow cross-user reach.
      const ownerPolicies = policies.filter((policy) => policy.name !== "tenant_isolation");
      expect(ownerPolicies).toHaveLength(5);
      for (const policy of ownerPolicies) {
        expect(policy.permissive).toBe(false);
        expect(policy.roles).toEqual(["studafy_app"]);
        expect(policy.using_expression).toContain("current_user_id()");
      }

      // WITH CHECK exists exactly where a row could otherwise be re-addressed to another user.
      const withCheck = ownerPolicies
        .filter((policy) => policy.check_expression !== null)
        .map((policy) => policy.name);
      expect(withCheck.sort()).toEqual([
        "notification_preferences_owner",
        "notifications_owner_update",
        "user_devices_owner",
      ]);

      // Both SECURITY DEFINER functions are owned by studafy_admin -- that ownership is what lets
      // them step outside the studafy_app-scoped restrictive policies -- and only the token claim is
      // callable by the runtime role.
      const functions = await database.sql<
        { name: string; owner: string; definer: boolean; app_execute: boolean }[]
      >`
        SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner,
          p.prosecdef AS definer,
          has_function_privilege('studafy_app', p.oid, 'EXECUTE') AS app_execute
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.proname IN ('seed_default_notification_preferences', 'claim_device_token')
        ORDER BY p.proname
      `;
      expect([...functions]).toEqual([
        {
          name: "claim_device_token",
          owner: "studafy_admin",
          definer: true,
          app_execute: true,
        },
        {
          name: "seed_default_notification_preferences",
          owner: "studafy_admin",
          definer: true,
          app_execute: false,
        },
      ]);

      const indexes = await database.sql<{ name: string }[]>`
        SELECT indexname AS name FROM pg_indexes
        WHERE schemaname = 'app' AND tablename = ANY(${TENANT_TABLES as unknown as string[]})
        ORDER BY indexname
      `;
      expect(indexes.map((row) => row.name)).toEqual([
        "idx_notification_preferences_school_user_type_channel",
        "idx_notifications_digest_pending",
        "idx_notifications_school_user_created",
        "idx_notifications_school_user_unread",
        "idx_user_devices_school_user_platform_last_seen",
        "pk_notification_preferences",
        "pk_notifications",
        "pk_user_devices",
        "uq_notifications_id_school",
        "uq_user_devices_id_school",
        "uq_user_devices_user_token",
      ]);
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "seeds the default preference matrix on activation, once, and idempotently",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "notify-seed");

      // An invited user is not yet a recipient: nothing is seeded until they activate.
      const invited = await createUser(database, school, "invited", "invited");
      expect(await countPreferences(database, school, invited)).toBe(0);

      // A user created active is seeded on INSERT.
      const active = await createUser(database, school, "active", "active");
      expect(await countPreferences(database, school, active)).toBe(DEFAULT_PREFERENCES);

      const seeded = await asUser(
        database,
        { school },
        (tx) =>
          tx<{ notification_type: string; channel: string; enabled: boolean }[]>`
            SELECT notification_type::text, channel::text, enabled
            FROM app.notification_preferences WHERE user_id = ${active}
          `,
        "studafy_admin",
      );
      expect(seeded.every((row) => row.enabled)).toBe(true);
      expect(new Set(seeded.map((row) => row.notification_type))).toEqual(
        new Set(NOTIFICATION_TYPES),
      );
      expect(new Set(seeded.map((row) => row.channel))).toEqual(new Set(NOTIFICATION_CHANNELS));

      // Activating the invited user later seeds them then, on the status transition.
      await asUser(database, { school, user: invited }, async (tx) => {
        await tx`UPDATE app.users SET status = 'active' WHERE id = ${invited}`;
      });
      expect(await countPreferences(database, school, invited)).toBe(DEFAULT_PREFERENCES);

      // The user turns one channel off, then is suspended and reactivated. Re-activation must not
      // resurrect the preference they deliberately disabled, and must not duplicate rows.
      await asUser(database, { school, user: active }, async (tx) => {
        const updated = await tx`
          UPDATE app.notification_preferences SET enabled = false
          WHERE user_id = ${active} AND notification_type = 'GRADE_POSTED' AND channel = 'email'
        `;
        expect(updated.count).toBe(1);
      });
      await asUser(database, { school, user: active }, async (tx) => {
        await tx`UPDATE app.users SET status = 'suspended' WHERE id = ${active}`;
        await tx`UPDATE app.users SET status = 'active' WHERE id = ${active}`;
      });
      expect(await countPreferences(database, school, active)).toBe(DEFAULT_PREFERENCES);

      const [disabled] = await asUser(
        database,
        { school },
        (tx) =>
          tx<{ enabled: boolean }[]>`
            SELECT enabled FROM app.notification_preferences
            WHERE user_id = ${active} AND notification_type = 'GRADE_POSTED' AND channel = 'email'
          `,
        "studafy_admin",
      );
      expect(disabled!.enabled).toBe(false);
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "registers devices idempotently and transfers a token that changes hands",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "notify-devices");
      const alice = await createUser(database, school, "alice");
      const bob = await createUser(database, school, "bob");
      const token = "fcm-token-shared-handset";

      // Alice registers the handset. Nothing to claim: no one else holds the token.
      const aliceClaim = await asUser(database, { school, user: alice }, async (tx) => {
        const [claim] = await tx<{ revoked: number }[]>`
          SELECT app.claim_device_token(${token}) AS revoked
        `;
        await tx`
          INSERT INTO app.user_devices (school_id, user_id, fcm_token, platform)
          VALUES (${school}, ${alice}, ${token}, 'ios')
        `;
        return claim!.revoked;
      });
      expect(aliceClaim).toBe(0);

      // Re-registering the same token upserts in place rather than accumulating a second route.
      await asUser(database, { school, user: alice }, async (tx) => {
        await tx`
          INSERT INTO app.user_devices (school_id, user_id, fcm_token, platform, last_seen)
          VALUES (${school}, ${alice}, ${token}, 'web', CURRENT_TIMESTAMP)
          ON CONFLICT ON CONSTRAINT uq_user_devices_user_token
          DO UPDATE SET last_seen = EXCLUDED.last_seen, platform = EXCLUDED.platform,
                        revoked_at = NULL, updated_at = CURRENT_TIMESTAMP
        `;
        const [count] = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.user_devices
        `;
        expect(count!.count).toBe("1");
        const [device] = await tx<{ platform: string }[]>`
          SELECT platform::text FROM app.user_devices WHERE user_id = ${alice}
        `;
        expect(device!.platform).toBe("web");
      });

      // The handset passes to Bob. He cannot see Alice's row, so the claim function is the only way
      // the stale route can be retired -- and it is what makes his own insert conflict-free.
      const bobClaim = await asUser(database, { school, user: bob }, async (tx) => {
        const [visible] = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.user_devices
        `;
        expect(visible!.count).toBe("0");

        const [claim] = await tx<{ revoked: number }[]>`
          SELECT app.claim_device_token(${token}) AS revoked
        `;
        await tx`
          INSERT INTO app.user_devices (school_id, user_id, fcm_token, platform)
          VALUES (${school}, ${bob}, ${token}, 'android')
        `;
        return claim!.revoked;
      });
      expect(bobClaim).toBe(1);

      // Exactly one live route for the token, and it is Bob's. Alice's is revoked, not deleted.
      const routes = await asUser(
        database,
        { school },
        (tx) =>
          tx<{ user_id: string; platform: string; live: boolean }[]>`
            SELECT user_id, platform::text, revoked_at IS NULL AS live
            FROM app.user_devices WHERE fcm_token = ${token} ORDER BY live
          `,
        "studafy_admin",
      );
      expect([...routes]).toEqual([
        { user_id: alice, platform: "web", live: false },
        { user_id: bob, platform: "android", live: true },
      ]);

      // The claim function cannot revoke the caller's own live route.
      const selfClaim = await asUser(database, { school, user: bob }, async (tx) => {
        const [claim] = await tx<{ revoked: number }[]>`
          SELECT app.claim_device_token(${token}) AS revoked
        `;
        return claim!.revoked;
      });
      expect(selfClaim).toBe(0);

      // An empty token is rejected by the function and by ck_user_devices_fcm_token.
      await expectDenied(database, `SELECT app.claim_device_token('   ')`, {
        school,
        user: bob,
      });
      await expectDenied(
        database,
        `INSERT INTO app.user_devices (school_id, user_id, fcm_token, platform)
         VALUES ('${school}', '${bob}', '  ', 'ios')`,
        { school, user: bob },
      );
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "isolates notifications, preferences, and devices by user as well as by school",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "notify-tenant-a");
      const schoolB = await createSchool(database, "notify-tenant-b");
      const alice = await createUser(database, schoolA, "iso-alice");
      const bob = await createUser(database, schoolA, "iso-bob");
      const carol = await createUser(database, schoolB, "iso-carol");

      // Alice sends Bob a notification. Cross-user INSERT is allowed by design -- a sender addresses
      // a recipient -- and is still confined to Alice's own school by tenant_isolation.
      await asUser(database, { school: schoolA, user: alice }, async (tx) => {
        await tx`
          INSERT INTO app.notifications
            (school_id, user_id, notification_type, title, body, metadata)
          VALUES (${schoolA}, ${bob}, 'GRADE_POSTED', 'Grade posted', 'Your grade is in',
                  ${tx.json({ assignmentId: "00000000-0000-0000-0000-000000000001" })})
        `;
        // ...but she cannot read back what she wrote for him.
        const [seen] = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.notifications
        `;
        expect(seen!.count).toBe("0");
      });

      // Bob is the recipient and sees exactly one, and may mark his own read.
      await asUser(database, { school: schoolA, user: bob }, async (tx) => {
        const [seen] = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.notifications
        `;
        expect(seen!.count).toBe("1");
        const read = await tx`
          UPDATE app.notifications SET read_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ${bob}
        `;
        expect(read.count).toBe(1);
      });

      // Alice cannot read, update, or delete Bob's rows -- across all three tables, and without an
      // error: the rows simply are not there for her.
      await asUser(database, { school: schoolA, user: alice }, async (tx) => {
        for (const table of TENANT_TABLES) {
          const [visible] = await tx.unsafe<{ count: string }[]>(
            `SELECT count(*)::text AS count FROM app.${table} WHERE user_id = '${bob}'`,
          );
          expect(visible!.count).toBe("0");
        }
        const updated = await tx`
          UPDATE app.notifications SET read_at = NULL WHERE user_id = ${bob}
        `;
        const deleted = await tx`DELETE FROM app.notifications WHERE user_id = ${bob}`;
        const prefs = await tx`
          UPDATE app.notification_preferences SET enabled = false WHERE user_id = ${bob}
        `;
        expect(updated.count).toBe(0);
        expect(deleted.count).toBe(0);
        expect(prefs.count).toBe(0);
      });

      // Bob's own notification survived Alice's attempts, still read.
      const [survivor] = await asUser(
        database,
        { school: schoolA, user: bob },
        (tx) =>
          tx<{ read: boolean }[]>`
            SELECT read_at IS NOT NULL AS read FROM app.notifications WHERE user_id = ${bob}
          `,
      );
      expect(survivor!.read).toBe(true);

      // Re-addressing an existing row to another user is blocked by the UPDATE policy's WITH CHECK,
      // and so is smuggling one across the tenant boundary.
      await expectDenied(
        database,
        `UPDATE app.notifications SET user_id = '${alice}' WHERE user_id = '${bob}'`,
        { school: schoolA, user: bob },
      );
      await expectDenied(
        database,
        `UPDATE app.notifications SET school_id = '${schoolB}' WHERE user_id = '${bob}'`,
        { school: schoolA, user: bob },
      );
      // Nor may a user write a preference row or a device row belonging to someone else.
      await expectDenied(
        database,
        `INSERT INTO app.user_devices (school_id, user_id, fcm_token, platform)
         VALUES ('${schoolA}', '${bob}', 'stolen-token', 'ios')`,
        { school: schoolA, user: alice },
      );
      await expectDenied(
        database,
        `INSERT INTO app.notification_preferences (school_id, user_id, notification_type, channel)
         VALUES ('${schoolA}', '${bob}', 'SUPPORT_MESSAGE', 'push')`,
        { school: schoolA, user: alice },
      );

      // Carol is in another school entirely. Even holding Bob's user id, the tenant boundary is the
      // outer one and she reaches nothing.
      await asUser(database, { school: schoolB, user: carol }, async (tx) => {
        for (const table of TENANT_TABLES) {
          const [visible] = await tx.unsafe<{ count: string }[]>(
            `SELECT count(*)::text AS count FROM app.${table} WHERE user_id = '${bob}'`,
          );
          expect(visible!.count).toBe("0");
        }
      });
      // A cross-tenant notification cannot be forged: the composite foreign key to
      // app.users (id, school_id) makes the mismatched pair unrepresentable, and RLS rejects the
      // school_id that would make it representable.
      await expectDenied(
        database,
        `INSERT INTO app.notifications (school_id, user_id, notification_type, title, body)
         VALUES ('${schoolB}', '${bob}', 'SUPPORT_MESSAGE', 'Hi', 'There')`,
        { school: schoolB, user: carol },
      );

      // Fail closed. A missing or malformed context is an error, not an open door -- and forced RLS
      // means that holds for the table owner too, not only the runtime role.
      for (const table of TENANT_TABLES) {
        await expectDenied(database, `SELECT count(*) FROM app.${table}`);
        for (const bad of ["", " ", "not-a-uuid"]) {
          await expectDenied(database, `SELECT count(*) FROM app.${table}`, { school: bad });
          await expectDenied(database, `SELECT count(*) FROM app.${table}`, {
            school: schoolA,
            user: bad,
          });
        }
        await expectDenied(
          database,
          `SELECT count(*) FROM app.${table}`,
          undefined,
          "studafy_admin",
        );
      }

      // Setting only the tenant GUC is not enough: the restrictive policy needs app.user_id, and an
      // unset one raises rather than matching every row.
      await expectDenied(database, "SELECT count(*) FROM app.notifications", { school: schoolA });

      // The runtime role cannot dismantle any of this, nor seed preferences behind the trigger's back.
      await expectDenied(database, "ALTER TABLE app.notifications NO FORCE ROW LEVEL SECURITY", {
        school: schoolA,
        user: alice,
      });
      await expectDenied(database, "DROP POLICY notifications_owner_select ON app.notifications", {
        school: schoolA,
        user: alice,
      });
      await expectDenied(database, "DROP POLICY tenant_isolation ON app.user_devices", {
        school: schoolA,
        user: alice,
      });
      await expectDenied(database, "SELECT app.apply_tenant_isolation('app', 'notifications')", {
        school: schoolA,
        user: alice,
      });
      await expectDenied(database, "SELECT app.seed_default_notification_preferences()", {
        school: schoolA,
        user: alice,
      });
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);
