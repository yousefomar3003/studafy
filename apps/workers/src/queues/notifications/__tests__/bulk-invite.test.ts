/**
 * Bulk invitation processor: the happy path, per-recipient failure, and the no-progress guard.
 *
 * Real Postgres, skipped unless TEST_DATABASE_URL points at an already-migrated database (the
 * apps/workers convention — see attendance-alert.test.ts).
 *
 * The guard test reproduces the loop that used to spin forever: a recipient whose invitation
 * insert fails *and* whose mark-failed UPDATE matches nothing (what RLS did to the old
 * outside-a-transaction write) stays `pending`, so every page re-read returned the same rows. Two
 * triggers scoped to the fixture's school stand in for those two failures.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { BulkInviteStalledError, processBulkInvite } from "../bulk-invite-processor";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

let sql: Sql;

beforeAll(() => {
  if (!databaseUrl) return;
  sql = postgres(databaseUrl, { max: 2, idle_timeout: 20, prepare: false });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

interface Fixture {
  schoolId: string;
  bulkInviteId: string;
}

let fixtureSeq = 0;

/** A school with one admin and a bulk invite of `recipientCount` pending recipients. */
async function seedFixture(recipientCount: number): Promise<Fixture> {
  fixtureSeq += 1;
  const tag = `bulk${fixtureSeq}-${Date.now().toString(36)}`;

  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    // Column list mirrors createSchool in apps/api/tests/harness/factories.ts.
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const schoolEmail = `${tag}@admin.local`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${tag}, ${`Bulk ${tag}`}, ${schoolEmail}, ${schoolEmail},
              ${reference!.country}, ${reference!.currency})
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const [admin] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${`a-${tag}@t.local`}, ${`a-${tag}@t.local`}, 'Admin', 'active')
      RETURNING id
    `;
    const [bulk] = await tx<{ id: string }[]>`
      INSERT INTO app.bulk_invites (school_id, created_by, role, target_mode, total_count)
      VALUES (${schoolId}::uuid, ${admin!.id}::uuid, 'INSTRUCTOR', 'emails', ${recipientCount})
      RETURNING id
    `;
    for (let i = 0; i < recipientCount; i += 1) {
      const email = `r${i}-${tag}@t.local`;
      await tx`
        INSERT INTO app.bulk_invite_recipients (bulk_invite_id, school_id, email, normalized_email)
        VALUES (${bulk!.id}::uuid, ${schoolId}::uuid, ${email}, ${email})
      `;
    }
    return { schoolId, bulkInviteId: bulk!.id };
  });
}

async function recipientStatuses(fixture: Fixture): Promise<string[]> {
  const rows = await sql<{ status: string }[]>`
    SELECT status::text AS status FROM app.bulk_invite_recipients
    WHERE bulk_invite_id = ${fixture.bulkInviteId}::uuid
    ORDER BY email
  `;
  return rows.map((row) => row.status);
}

async function batchStatus(fixture: Fixture): Promise<string | undefined> {
  const [row] = await sql<{ status: string }[]>`
    SELECT status::text AS status FROM app.bulk_invites WHERE id = ${fixture.bulkInviteId}::uuid
  `;
  return row?.status;
}

/**
 * Make every invitation insert for `schoolId` throw and, when `swallowFailedWrites`, make every
 * recipient UPDATE to `failed` match nothing. Returns the cleanup.
 */
async function sabotage(
  schoolId: string,
  options: { swallowFailedWrites: boolean },
): Promise<() => Promise<void>> {
  const suffix = schoolId.replaceAll("-", "");
  const insertFn = `app.test_fail_invite_${suffix}`;
  const updateFn = `app.test_swallow_failed_${suffix}`;

  await sql.unsafe(`
    CREATE FUNCTION ${insertFn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.school_id = '${schoolId}'::uuid THEN
        RAISE EXCEPTION 'invitation insert sabotaged by test';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_fail_invite_${suffix} BEFORE INSERT ON app.invitations
      FOR EACH ROW EXECUTE FUNCTION ${insertFn}();
  `);
  if (options.swallowFailedWrites) {
    await sql.unsafe(`
      CREATE FUNCTION ${updateFn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.school_id = '${schoolId}'::uuid AND NEW.status = 'failed' THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_swallow_failed_${suffix} BEFORE UPDATE ON app.bulk_invite_recipients
        FOR EACH ROW EXECUTE FUNCTION ${updateFn}();
    `);
  }

  return async () => {
    await sql.unsafe(`
      DROP TRIGGER test_fail_invite_${suffix} ON app.invitations;
      DROP FUNCTION ${insertFn}();
    `);
    if (options.swallowFailedWrites) {
      await sql.unsafe(`
        DROP TRIGGER test_swallow_failed_${suffix} ON app.bulk_invite_recipients;
        DROP FUNCTION ${updateFn}();
      `);
    }
  };
}

describeDb("processBulkInvite", () => {
  test("invites every pending recipient and completes the batch", async () => {
    const fixture = await seedFixture(3);

    const result = await processBulkInvite(fixture, databaseUrl!);

    expect(result).toEqual({ sent: 3, failed: 0 });
    expect(await recipientStatuses(fixture)).toEqual(["sent", "sent", "sent"]);
    expect(await batchStatus(fixture)).toBe("completed");

    // One invitation.sent event per recipient, carrying the token the email's accept link needs.
    const events = await sql<{ payload: { token?: string } }[]>`
      SELECT payload FROM app.outbox_events
      WHERE school_id = ${fixture.schoolId}::uuid AND event_name = 'invitation.sent'
    `;
    expect(events).toHaveLength(3);
    for (const event of events) expect(event.payload.token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("runs on a borrowed pool without ending it", async () => {
    const fixture = await seedFixture(1);

    await processBulkInvite(fixture, sql);

    // Still usable: the processor released nothing it did not open.
    const [row] = await sql<{ one: number }[]>`SELECT 1 AS one`;
    expect(row!.one).toBe(1);
    expect(await recipientStatuses(fixture)).toEqual(["sent"]);
  });

  test("marks a recipient whose invitation fails as failed and still completes", async () => {
    const fixture = await seedFixture(2);
    const cleanup = await sabotage(fixture.schoolId, { swallowFailedWrites: false });
    try {
      const result = await processBulkInvite(fixture, databaseUrl!);

      expect(result).toEqual({ sent: 0, failed: 2 });
      expect(await recipientStatuses(fixture)).toEqual(["failed", "failed"]);
      expect(await batchStatus(fixture)).toBe("completed");
    } finally {
      await cleanup();
    }
  });

  test("stops instead of looping when a page makes no progress", async () => {
    const fixture = await seedFixture(2);
    const cleanup = await sabotage(fixture.schoolId, { swallowFailedWrites: true });
    try {
      let caught: unknown;
      try {
        await processBulkInvite(fixture, databaseUrl!);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(BulkInviteStalledError);
      // Nothing moved, and the batch says so rather than sitting in `processing`.
      expect(await recipientStatuses(fixture)).toEqual(["pending", "pending"]);
      expect(await batchStatus(fixture)).toBe("failed");
    } finally {
      await cleanup();
    }
  });
});
