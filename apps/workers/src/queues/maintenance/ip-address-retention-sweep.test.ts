/**
 * The IP address retention sweep, against a real database.
 *
 * Seeds one school with more 91-day-old sessions than a batch holds plus one 89-day-old session, all
 * with IP addresses; security events of the same two ages; and audit-log rows of both ages. The
 * acceptance the test proves: after the sweep only the old sessions' and old events' addresses are
 * NULL, across batches; the recent ones and every audit-log address are untouched. Skipped (as a
 * `skipIf` test) unless TEST_DATABASE_URL is set; the database must already be migrated.
 *
 * Cleanup: sessions, security events and users are removed afterwards. The seeded audit-log rows
 * cannot be -- app.audit_logs is append-only even for its owner -- so the school they reference
 * stays behind (slug `ip-retention-*`), the same as any audit-log-writing test leaves its rows.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  IP_ADDRESS_RETENTION_BATCH_SIZE,
  purgeExpiredIpAddresses,
} from "./ip-address-retention-sweep";

import type { PurgeLogger } from "../imports";
import type { Sql, TransactionSql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const sweepTest = test.skipIf(!enabled);

const OLD = "91 days";
const RECENT = "89 days";

let db: Sql | undefined;

/** Schools and security-event request ids seeded by this file, so afterAll can remove them. */
const seededSchools: string[] = [];
const seededEventRequestIds: string[] = [];

const silentLogger: PurgeLogger = { warn: () => undefined };

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  if (db) {
    await removeSeededRows();
    await db.end({ timeout: 5 });
  }
});

/** Runs [fn] as the table owner inside [schoolId]'s tenant, the way the seeds and checks need. */
function asSchool<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

function asAdmin<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    return fn(tx);
  }) as Promise<T>;
}

/** A school with one user. */
async function seedSchool(): Promise<{ schoolId: string; userId: string }> {
  return asAdmin(async (tx) => {
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'JO') AS country,
        (SELECT id FROM app.currencies WHERE code = 'JOD') AS currency
    `;

    const slug = `ip-retention-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`IP Retention School ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const schoolId = school!.id;
    seededSchools.push(schoolId);

    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email)
      VALUES (${schoolId}::uuid, ${`${slug}@user.local`}, ${`${slug}@user.local`})
      RETURNING id
    `;
    return { schoolId, userId: user!.id };
  });
}

/** Inserts [count] sessions created [age] ago, each with an IP address. */
async function seedSessions(
  schoolId: string,
  userId: string,
  count: number,
  age: string,
): Promise<void> {
  await asSchool(schoolId, async (tx) => {
    await tx`
      INSERT INTO app.refresh_tokens
        (school_id, user_id, token_hash, family_id, channel, ip_address, issued_at, created_at,
         expires_at)
      SELECT ${schoolId}::uuid, ${userId}::uuid, digest(gen_random_uuid()::text, 'sha256'),
             gen_random_uuid(), 'web', '203.0.113.7'::inet,
             now() - ${age}::interval, now() - ${age}::interval,
             now() - ${age}::interval + interval '30 days'
      FROM generate_series(1, ${count})
    `;
  });
}

/** Inserts [count] security events created [age] ago, each with an IP address. */
async function seedSecurityEvents(count: number, age: string): Promise<void> {
  const requestId = crypto.randomUUID();
  seededEventRequestIds.push(requestId);
  await asAdmin(async (tx) => {
    await tx`
      INSERT INTO app.security_events
        (event_type, request_path, request_method, client_ip, request_id, created_at)
      SELECT 'csrf_missing_token', '/api/test', 'POST', '198.51.100.9'::inet, ${requestId}::uuid,
             now() - ${age}::interval
      FROM generate_series(1, ${count})
    `;
  });
}

/** One audit-log row created [age] ago with an IP address; makes sure its month's partition exists. */
async function seedAuditLog(schoolId: string, age: string): Promise<void> {
  await asSchool(schoolId, async (tx) => {
    await tx`SELECT app.create_audit_log_partitions((now() - ${age}::interval)::date)`;
    await tx`
      INSERT INTO app.audit_logs
        (school_id, action, target_table, target_id, new_values, client_ip, created_at)
      VALUES (${schoolId}::uuid, 'insert', 'users', gen_random_uuid(), '{}'::jsonb,
              '192.0.2.1'::inet, now() - ${age}::interval)
    `;
  });
}

interface IpCounts {
  oldWithIp: number;
  oldWithoutIp: number;
  recentWithIp: number;
  recentWithoutIp: number;
}

const COUNTS = `
  count(*) FILTER (WHERE created_at < now() - interval '90 days' AND ip IS NOT NULL)::int AS "oldWithIp",
  count(*) FILTER (WHERE created_at < now() - interval '90 days' AND ip IS NULL)::int AS "oldWithoutIp",
  count(*) FILTER (WHERE created_at >= now() - interval '90 days' AND ip IS NOT NULL)::int AS "recentWithIp",
  count(*) FILTER (WHERE created_at >= now() - interval '90 days' AND ip IS NULL)::int AS "recentWithoutIp"
`;

async function sessionCounts(schoolId: string): Promise<IpCounts> {
  return asSchool(schoolId, async (tx) => {
    const [row] = await tx.unsafe<IpCounts[]>(
      `SELECT ${COUNTS} FROM (SELECT created_at, ip_address AS ip FROM app.refresh_tokens
         WHERE school_id = $1::uuid) AS t`,
      [schoolId],
    );
    return { ...row! };
  });
}

async function securityEventCounts(): Promise<IpCounts> {
  return asAdmin(async (tx) => {
    const [row] = await tx.unsafe<IpCounts[]>(
      `SELECT ${COUNTS} FROM (SELECT created_at, client_ip AS ip FROM app.security_events
         WHERE request_id = ANY($1::uuid[])) AS t`,
      [seededEventRequestIds],
    );
    return { ...row! };
  });
}

async function auditLogCounts(schoolId: string): Promise<IpCounts> {
  return asSchool(schoolId, async (tx) => {
    const [row] = await tx.unsafe<IpCounts[]>(
      `SELECT ${COUNTS} FROM (SELECT created_at, client_ip AS ip FROM app.audit_logs
         WHERE school_id = $1::uuid) AS t`,
      [schoolId],
    );
    return { ...row! };
  });
}

/** Remove every removable row the seeds created. Audit-log rows, and so their school, stay. */
async function removeSeededRows(): Promise<void> {
  try {
    await asAdmin(async (tx) => {
      await tx`DELETE FROM app.security_events WHERE request_id = ANY(${seededEventRequestIds}::uuid[])`;
    });
  } catch (error) {
    silentLogger.warn({ error }, "failed to clean up seeded security events");
  }
  for (const schoolId of seededSchools) {
    try {
      await asSchool(schoolId, async (tx) => {
        await tx`DELETE FROM app.refresh_tokens WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.users WHERE school_id = ${schoolId}::uuid`;
      });
    } catch (error) {
      silentLogger.warn({ school_id: schoolId, error }, "failed to clean up seeded school");
    }
  }
}

describe("IP address retention sweep", () => {
  sweepTest(
    "removes IP addresses older than 90 days from sessions and security events; keeps recent ones and audit logs",
    async () => {
      const { schoolId, userId } = await seedSchool();
      await seedSessions(schoolId, userId, IP_ADDRESS_RETENTION_BATCH_SIZE + 1, OLD);
      await seedSessions(schoolId, userId, 2, RECENT);
      await seedSecurityEvents(IP_ADDRESS_RETENTION_BATCH_SIZE + 1, OLD);
      await seedSecurityEvents(2, RECENT);
      await seedAuditLog(schoolId, "120 days");
      await seedAuditLog(schoolId, "1 day");

      const result = await purgeExpiredIpAddresses(db!, new Date(), silentLogger);

      expect(result.failed).toBe(0);
      expect(result.sessionIpsCleared).toBeGreaterThanOrEqual(IP_ADDRESS_RETENTION_BATCH_SIZE + 1);
      expect(result.securityEventIpsCleared).toBeGreaterThanOrEqual(
        IP_ADDRESS_RETENTION_BATCH_SIZE + 1,
      );
      expect(await sessionCounts(schoolId)).toEqual({
        oldWithIp: 0,
        oldWithoutIp: IP_ADDRESS_RETENTION_BATCH_SIZE + 1,
        recentWithIp: 2,
        recentWithoutIp: 0,
      });
      expect(await securityEventCounts()).toEqual({
        oldWithIp: 0,
        oldWithoutIp: IP_ADDRESS_RETENTION_BATCH_SIZE + 1,
        recentWithIp: 2,
        recentWithoutIp: 0,
      });
      expect(await auditLogCounts(schoolId)).toEqual({
        oldWithIp: 1,
        oldWithoutIp: 0,
        recentWithIp: 1,
        recentWithoutIp: 0,
      });

      // A second run finds nothing left to clear in this school.
      const again = await purgeExpiredIpAddresses(db!, new Date(), silentLogger);
      expect(again.failed).toBe(0);
      expect(await sessionCounts(schoolId)).toMatchObject({ oldWithIp: 0, recentWithIp: 2 });
    },
    60_000,
  );
});
