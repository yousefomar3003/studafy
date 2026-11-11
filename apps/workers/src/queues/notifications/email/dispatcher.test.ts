/**
 * Email dispatcher: discovery-driven cycles and the transient-failure retry schedule (000200).
 *
 * Needs a migrated TEST_DATABASE_URL. Rows are seeded straight into the outbox; the sender is a stub
 * so each test decides what a send does.
 */

import { DOMAIN_EVENTS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { EMAIL_MAX_SEND_ATTEMPTS, emailRetryDelayMs, pollOnce, processSchool } from "./dispatcher";

import type { EmailDispatcherContext } from "./dispatcher";
import type { EmailSender, OutboundEmail } from "./sender";
import type { Sql } from "postgres";

describe("emailRetryDelayMs", () => {
  test("doubles from 30 s and caps at an hour", () => {
    const delays = Array.from({ length: EMAIL_MAX_SEND_ATTEMPTS - 1 }, (_, i) =>
      emailRetryDelayMs(i + 1),
    );
    expect(delays).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000,
    ]);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const dbTest = test.skipIf(!databaseUrl);

let db: Sql | undefined;

beforeAll(() => {
  if (!databaseUrl) return;
  db = postgres(databaseUrl, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function transientError(): Error {
  const err = new Error("connect ETIMEDOUT");
  err.name = "ETIMEDOUT";
  return err;
}

/** A sender whose behaviour is chosen per recipient; records every attempt. */
function stubSender(failures = new Map<string, () => Error>()) {
  const attempts: OutboundEmail[] = [];
  const sender: EmailSender = {
    send: async (email) => {
      attempts.push(email);
      const fail = failures.get(email.to);
      if (fail) throw fail();
      return { messageId: `msg-${crypto.randomUUID()}`, dryRun: false };
    },
  };
  return { sender, attempts };
}

function context(sender: EmailSender): EmailDispatcherContext {
  return {
    db: db!,
    sender,
    limiter: { wait: async () => undefined },
    config: { batchSize: 25, pollIntervalMs: 1_000, ratePerSecond: 100, frontendUrl: "http://x" },
    logger: silentLogger,
  };
}

async function seedSchool(): Promise<string> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const slug = `mail-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Mail ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    return school!.id;
  });
}

async function seedInvitation(schoolId: string, email: string, attempts = 0): Promise<string> {
  const rows = await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return tx<{ id: string }[]>`
      INSERT INTO app.outbox_events (school_id, event_name, payload, relayed_at, email_attempts)
      VALUES (
        ${schoolId}::uuid, ${DOMAIN_EVENTS.INVITATION_SENT},
        ${tx.json({ email, token: "tok", expiresAt: "2030-01-01T00:00:00.000Z" })},
        CURRENT_TIMESTAMP, ${attempts}
      )
      RETURNING id::text AS id
    `;
  });
  return rows[0]!.id;
}

interface RowState {
  dispatched: boolean;
  attempts: number;
  next_attempt_in_s: number | null;
  deliveries: { status: string; attempts: number; last_error: string | null }[];
}

async function readRow(schoolId: string, id: string): Promise<RowState> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<Omit<RowState, "deliveries">[]>`
      SELECT email_dispatched_at IS NOT NULL AS dispatched,
             email_attempts::int AS attempts,
             extract(epoch FROM email_next_attempt_at - CURRENT_TIMESTAMP)::float8 AS next_attempt_in_s
      FROM app.outbox_events WHERE id = ${id}::bigint
    `;
    const deliveries = await tx<RowState["deliveries"]>`
      SELECT status::text AS status, attempts::int AS attempts, last_error
      FROM app.email_deliveries WHERE outbox_event_id = ${id}::bigint
    `;
    return { ...row!, deliveries: [...deliveries] };
  });
}

describe("email dispatcher", () => {
  dbTest("sends and records a pending invitation", async () => {
    const school = await seedSchool();
    const id = await seedInvitation(school, "ok@example.test");
    const { sender, attempts } = stubSender();

    expect(await processSchool(context(sender), school)).toBe(1);
    expect(attempts.map((a) => a.to)).toEqual(["ok@example.test"]);
    const state = await readRow(school, id);
    expect(state.dispatched).toBe(true);
    expect(state.deliveries.map((d) => d.status)).toEqual(["sent"]);
  });

  dbTest(
    "a transient failure reschedules the row without blocking the school's later mail",
    async () => {
      const school = await seedSchool();
      const failing = await seedInvitation(school, "flaky@example.test");
      const later = await seedInvitation(school, "fine@example.test");
      const { sender, attempts } = stubSender(new Map([["flaky@example.test", transientError]]));

      expect(await processSchool(context(sender), school)).toBe(2);
      expect(attempts.map((a) => a.to)).toEqual(["flaky@example.test", "fine@example.test"]);

      const deferred = await readRow(school, failing);
      expect(deferred.dispatched).toBe(false);
      expect(deferred.attempts).toBe(1);
      // 30 s out, give or take the test's own runtime.
      expect(deferred.next_attempt_in_s).toBeGreaterThan(20);
      expect(deferred.next_attempt_in_s).toBeLessThanOrEqual(30);
      // The attempt's delivery row was rolled back with its savepoint, so the retry is not mistaken
      // for a duplicate.
      expect(deferred.deliveries).toEqual([]);
      expect((await readRow(school, later)).deliveries.map((d) => d.status)).toEqual(["sent"]);

      // Held back until its retry time: the next cycle neither claims it nor sends again.
      expect(await processSchool(context(sender), school)).toBe(0);
      expect(attempts).toHaveLength(2);
    },
  );

  dbTest("a rescheduled row is retried once due, and sends normally", async () => {
    const school = await seedSchool();
    const id = await seedInvitation(school, "retry@example.test", 3);
    const { sender } = stubSender();

    expect(await processSchool(context(sender), school)).toBe(1);
    const state = await readRow(school, id);
    expect(state.dispatched).toBe(true);
    expect(state.deliveries.map((d) => d.status)).toEqual(["sent"]);
  });

  dbTest("the last allowed attempt dead-letters the row", async () => {
    const school = await seedSchool();
    const id = await seedInvitation(school, "down@example.test", EMAIL_MAX_SEND_ATTEMPTS - 1);
    const { sender } = stubSender(new Map([["down@example.test", transientError]]));

    expect(await processSchool(context(sender), school)).toBe(1);
    const state = await readRow(school, id);
    expect(state.dispatched).toBe(true);
    expect(state.attempts).toBe(EMAIL_MAX_SEND_ATTEMPTS);
    expect(state.next_attempt_in_s).toBeNull();
    expect(state.deliveries).toEqual([
      { status: "failed", attempts: EMAIL_MAX_SEND_ATTEMPTS, last_error: "connect ETIMEDOUT" },
    ]);
  });

  dbTest("a permanent failure is terminal at once, as before", async () => {
    const school = await seedSchool();
    const id = await seedInvitation(school, "bad@example.test");
    const { sender } = stubSender(new Map([["bad@example.test", () => new Error("rejected")]]));

    expect(await processSchool(context(sender), school)).toBe(1);
    const state = await readRow(school, id);
    expect(state.dispatched).toBe(true);
    expect(state.attempts).toBe(0);
    expect(state.deliveries.map((d) => d.status)).toEqual(["failed"]);
  });

  dbTest("a cycle visits only schools discovery names", async () => {
    const busy = await seedSchool();
    const id = await seedInvitation(busy, "cycle@example.test");
    const { sender, attempts } = stubSender();

    // Other suites may have left mail in other schools; this cycle drains whatever is pending.
    expect(await pollOnce(context(sender))).toBeGreaterThanOrEqual(1);
    expect(attempts.map((a) => a.to)).toContain("cycle@example.test");
    expect((await readRow(busy, id)).dispatched).toBe(true);

    // Dispatched rows drop out of discovery: the next cycle does not send it again.
    const second = stubSender();
    await pollOnce(context(second.sender));
    expect(second.attempts.map((a) => a.to)).not.toContain("cycle@example.test");
  });
});
