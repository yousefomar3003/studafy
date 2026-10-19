/**
 * The account-deletion sweep (000143), against a real database.
 *
 * Seeds one school with three accounts: one whose grace period has ended, one still inside it and
 * one with no deletion scheduled. The sweep must detach and file the erasure for the first only,
 * enqueue that erasure, and leave the other two untouched. Skipped (as a `skipIf` test) unless
 * TEST_DATABASE_URL is set.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { runAccountDeletionSweep } from "./account-deletion-sweep";

import type { BillingLogger } from "@studafy/billing";
import type { Sql, TransactionSql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const sweepTest = test.skipIf(!enabled);

let db: Sql | undefined;

const silentLogger: BillingLogger = { info: () => undefined, warn: () => undefined };

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

function asSchool<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** A school with three parents: deletion due, deletion pending, and no deletion. */
async function seed() {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'JO') AS country,
        (SELECT id FROM app.currencies WHERE code = 'JOD') AS currency
    `;
    const slug = `account-deletion-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Account Deletion School ${slug}`}, ${`${slug}@admin.local`},
        ${`${slug}@admin.local`}, ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const parent = async (label: string, schedule: string | null) => {
      const email = `${slug}-${label}@parent.local`;
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, status, deletion_requested_at, deletion_due_at)
        VALUES (
          ${schoolId}::uuid, ${email}, ${email}, 'active',
          ${schedule === null ? null : tx`now() + ${schedule}::interval - interval '14 days'`},
          ${schedule === null ? null : tx`now() + ${schedule}::interval`}
        )
        RETURNING id
      `;
      await tx`
        INSERT INTO app.user_roles (school_id, user_id, role)
        VALUES (${schoolId}::uuid, ${user!.id}::uuid, 'PARENT')
      `;
      await tx`
        INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
        VALUES (${schoolId}::uuid, ${user!.id}::uuid, 'google', ${crypto.randomUUID()})
      `;
      return user!.id;
    };

    return {
      schoolId,
      due: await parent("due", "-1 hour"),
      pending: await parent("pending", "3 days"),
      bystander: await parent("bystander", null),
    };
  });
}

async function stateOf(schoolId: string, userId: string) {
  return asSchool(schoolId, async (tx) => {
    const [row] = await tx<
      {
        status: string;
        roles: number;
        identities: number;
        erasures: number;
        deleted_events: number;
      }[]
    >`
      SELECT
        (SELECT status::text FROM app.users WHERE id = ${userId}::uuid) AS status,
        (SELECT count(*)::int FROM app.user_roles WHERE user_id = ${userId}::uuid) AS roles,
        (SELECT count(*)::int FROM app.oauth_identities WHERE user_id = ${userId}::uuid) AS identities,
        (SELECT count(*)::int FROM app.data_subject_requests
          WHERE subject_user_id = ${userId}::uuid AND request_type = 'erasure') AS erasures,
        (SELECT count(*)::int FROM app.outbox_events
          WHERE event_name = 'account.deleted' AND payload->>'userId' = ${userId}) AS deleted_events
    `;
    return row!;
  });
}

describe("account deletion sweep", () => {
  sweepTest("runs only deletions whose grace period has ended", async () => {
    const seeded = await seed();
    const enqueued: { schoolId: string; requestId: string; kind: string }[] = [];

    const result = await runAccountDeletionSweep(
      db!,
      new Date(),
      null,
      async (job) => {
        enqueued.push(job);
      },
      silentLogger,
    );

    expect(result.failures).toBe(0);
    expect(await stateOf(seeded.schoolId, seeded.due)).toEqual({
      status: "archived",
      roles: 0,
      identities: 0,
      erasures: 1,
      deleted_events: 1,
    });
    for (const untouched of [seeded.pending, seeded.bystander]) {
      expect(await stateOf(seeded.schoolId, untouched)).toEqual({
        status: "active",
        roles: 1,
        identities: 1,
        erasures: 0,
        deleted_events: 0,
      });
    }
    expect(enqueued.filter((job) => job.schoolId === seeded.schoolId)).toEqual([
      expect.objectContaining({ schoolId: seeded.schoolId, kind: "erasure" }),
    ]);

    // A second run finds nothing new for this school.
    enqueued.length = 0;
    await runAccountDeletionSweep(
      db!,
      new Date(),
      null,
      async (job) => {
        enqueued.push(job);
      },
      silentLogger,
    );
    expect(enqueued.filter((job) => job.schoolId === seeded.schoolId)).toEqual([]);
  });
});
