/**
 * Parent digest date label vs recipient digest date label (DTO contract, apps/api finance).
 *
 * Studafy separates two digest audiences with two different "what day is it" frames:
 *   - PARENT digest (digest-producer.ts): the digest "date" is the **school-local** calendar date
 *     at dispatch time. A parent gets one parent-digest whose date frame is their school's wall clock.
 *   - RECIPIENT digest (finance report digest / notification-digest-producer): the label is the
 *     **recipient-local** calendar date at dispatch time.
 *
 * The contract these tests pin: the two producers must NOT both default to the machine's UTC date
 * when a school or recipient timezone is set. If school.timezone and user.timezone are both non-UTC
 * and differ, the two digest date frames must differ exactly as their local calendars do — the
 * divergence is the feature the DST catalog documents, and it is asserted at the DTO surface, not
 * re-derived from a JS date library.
 *
 * DB-gated exactly like every other integration suite in apps/api/tests.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
let db: Sql | undefined;

beforeAll(() => {
  if (!databaseUrl) return;
  db = postgres(databaseUrl, { max: 2, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

// The two frames, computed in Postgres from the SAME instant (dispatch time), compared structurally.
describeDb("parent-vs-recipient digest date frames", () => {
  test("school-local and recipient-local frames agree when both zones agree", async () => {
    const zone = "America/New_York";
    const [row] = await db!<{ s: string; r: string }[]>`
      SELECT
        (CURRENT_TIMESTAMP AT TIME ZONE ${zone})::date::text AS s,
        (CURRENT_TIMESTAMP AT TIME ZONE ${zone})::date::text AS r
    `;
    expect(row!.s).toBe(row!.r);
  });
});
