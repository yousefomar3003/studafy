/**
 * The Ask AI message retention sweep (ST-309), against a real database.
 *
 * Seeds a school with one more expired message than a batch holds, plus one message still inside
 * its retention window. The acceptance the test proves: the sweep keeps batching until every
 * expired message is gone, and the unexpired one survives. Skipped (as a `skipIf` test) unless
 * TEST_DATABASE_URL is set.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { AI_MESSAGE_PURGE_BATCH_SIZE, purgeExpiredAiMessages } from "./ai-message-retention-sweep";

import type { PurgeLogger } from "../imports";
import type { Sql, TransactionSql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const sweepTest = test.skipIf(!enabled);

let db: Sql | undefined;

/** Schools seeded by this file, so afterAll can remove them and the DB is left as found. */
const seededSchools: string[] = [];

const silentLogger: PurgeLogger = { warn: () => undefined };

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  if (db) {
    await removeSeededSchools();
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

/** A school with one student and one Ask AI conversation. Returns the school and conversation. */
async function seedConversation(): Promise<{ schoolId: string; conversationId: string }> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'JO') AS country,
        (SELECT id FROM app.currencies WHERE code = 'JOD') AS currency
    `;

    const slug = `ai-retention-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`AI Retention School ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const schoolId = school!.id;
    seededSchools.push(schoolId);

    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email)
      VALUES (${schoolId}::uuid, ${`${slug}@student.local`}, ${`${slug}@student.local`})
      RETURNING id
    `;
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
      VALUES (${schoolId}::uuid, ${user!.id}::uuid, ${slug}, 'Retention', 'Student')
      RETURNING id
    `;
    const [conversation] = await tx<{ id: string }[]>`
      INSERT INTO app.ai_conversations (school_id, student_id, model)
      VALUES (${schoolId}::uuid, ${student!.id}::uuid, 'test-model')
      RETURNING id
    `;

    return { schoolId, conversationId: conversation!.id };
  });
}

/** Inserts [count] messages whose `expires_at` is [expiresIn] from now (negative = expired). */
async function seedMessages(
  schoolId: string,
  conversationId: string,
  count: number,
  expiresIn: string,
): Promise<void> {
  await asSchool(schoolId, async (tx) => {
    await tx`
      INSERT INTO app.ai_messages
        (school_id, conversation_id, question, answer, prompt_tokens, completion_tokens,
         total_tokens, expires_at)
      SELECT ${schoolId}::uuid, ${conversationId}::uuid, 'question', 'answer', 10, 5, 15,
             now() + ${expiresIn}::interval
      FROM generate_series(1, ${count})
    `;
  });
}

async function messageCounts(schoolId: string): Promise<{ expired: number; live: number }> {
  return asSchool(schoolId, async (tx) => {
    const [row] = await tx<{ expired: string; live: string }[]>`
      SELECT count(*) FILTER (WHERE expires_at < now())::text AS expired,
             count(*) FILTER (WHERE expires_at >= now())::text AS live
      FROM app.ai_messages
      WHERE school_id = ${schoolId}::uuid
    `;
    return { expired: Number(row!.expired), live: Number(row!.live) };
  });
}

/** Remove every row the seeds created, in FK-safe order — app.schools last. */
async function removeSeededSchools(): Promise<void> {
  for (const schoolId of seededSchools) {
    try {
      await asSchool(schoolId, async (tx) => {
        await tx`DELETE FROM app.ai_messages WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.ai_conversations WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.students WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.users WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.schools WHERE id = ${schoolId}::uuid`;
      });
    } catch (error) {
      silentLogger.warn({ school_id: schoolId, error }, "failed to clean up seeded school");
    }
  }
}

describe("Ask AI message retention sweep", () => {
  sweepTest("deletes every expired message across batches and keeps unexpired ones", async () => {
    const { schoolId, conversationId } = await seedConversation();
    await seedMessages(schoolId, conversationId, AI_MESSAGE_PURGE_BATCH_SIZE + 1, "-1 day");
    await seedMessages(schoolId, conversationId, 1, "89 days");

    const result = await purgeExpiredAiMessages(db!, silentLogger);

    expect(result.failed).toBe(0);
    expect(result.removed).toBeGreaterThanOrEqual(AI_MESSAGE_PURGE_BATCH_SIZE + 1);
    expect(await messageCounts(schoolId)).toEqual({ expired: 0, live: 1 });
  });
});
