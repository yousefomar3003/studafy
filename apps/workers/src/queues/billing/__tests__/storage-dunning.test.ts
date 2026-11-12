/**
 * The dunning sweep closes a storage add-on whose grace period ran out (db/migrations/000205), the
 * same way it closes an AI add-on: through the state machine, audited, no reminder emails. Closing it
 * only ends the larger cap; nothing the school stored is touched.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { runDunningSweep } from "../dunning-sweep";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const storageTest = test.skipIf(!databaseUrl);

let db: Sql | undefined;
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const DAY = 86_400_000;

beforeAll(() => {
  if (!databaseUrl) return;
  db = postgres(databaseUrl, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

async function seedStorageAddon(
  gracePeriodEndsAt: Date,
): Promise<{ schoolId: string; id: string }> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const slug = `st-dun-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      SELECT ${slug}, ${`Storage School ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
             (SELECT id FROM app.countries WHERE alpha2_code = 'US'),
             (SELECT id FROM app.currencies WHERE code = 'USD')
      RETURNING id
    `;
    await tx`SELECT set_config('app.school_id', ${school!.id}, true)`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.storage_subscriptions (
        school_id, cap_bytes, status, current_period_start, current_period_end, grace_period_ends_at
      ) VALUES (
        ${school!.id}::uuid, ${100 * 1024 ** 3}, 'grace_period',
        ${new Date(gracePeriodEndsAt.getTime() - 37 * DAY).toISOString()}::timestamptz,
        ${new Date(gracePeriodEndsAt.getTime() - 7 * DAY).toISOString()}::timestamptz,
        ${gracePeriodEndsAt.toISOString()}::timestamptz
      )
      RETURNING id
    `;
    return { schoolId: school!.id, id: row!.id };
  });
}

async function statusOf(schoolId: string, id: string): Promise<string> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<{ status: string }[]>`
      SELECT status::text AS status FROM app.storage_subscriptions WHERE id = ${id}::uuid
    `;
    return row!.status;
  });
}

describe("dunning sweep: storage add-on", () => {
  storageTest("closes one past its grace deadline and leaves one still inside it", async () => {
    const now = new Date();
    const expired = await seedStorageAddon(new Date(now.getTime() - DAY));
    const inGrace = await seedStorageAddon(new Date(now.getTime() + 3 * DAY));

    const result = await runDunningSweep(db!, now, silentLogger);

    expect(result.storageSuspensions).toBeGreaterThanOrEqual(1);
    expect(await statusOf(expired.schoolId, expired.id)).toBe("closed");
    expect(await statusOf(inGrace.schoolId, inGrace.id)).toBe("grace_period");

    const audits = await db!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${expired.schoolId}, true)`;
      return tx<{ target_table: string }[]>`
        SELECT target_table FROM app.audit_logs
        WHERE school_id = ${expired.schoolId}::uuid AND target_id = ${expired.id}::uuid
      `;
    });
    expect(audits.map((row) => row.target_table)).toEqual(["storage_subscriptions"]);
  });
});
