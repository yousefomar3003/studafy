/**
 * The Student AI weekly statements job (000251): which week a Monday run states, and that a run
 * with nothing to state builds nothing and tells nobody. The statements themselves (collected
 * months, shares, approval, activation) are covered against the API in
 * apps/api/tests/licensing/ai-revenue-share-statements.integration.test.ts.
 *
 * The database part needs TEST_DATABASE_URL pointing at a fully migrated database, like the other
 * billing job tests.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { runAiRevenueShareStatements, statementWeekFor } from "../ai-revenue-share-statements";
import { AI_REVENUE_SHARE_STATEMENTS_CRON_PATTERN } from "../license-schedulers";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const jobTest = test.skipIf(!databaseUrl);
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let db: Sql | null = null;

beforeAll(() => {
  if (databaseUrl) db = postgres(databaseUrl, { max: 2, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

describe("the weekly statements job", () => {
  test("runs every Monday at 06:00 UTC", () => {
    expect(AI_REVENUE_SHARE_STATEMENTS_CRON_PATTERN).toBe("0 6 * * 1");
  });

  test("a run states the Monday-to-Sunday week that just ended", () => {
    // Monday 23 Nov 2026, 06:00 UTC: the week of Monday 16 Nov.
    expect(statementWeekFor(new Date("2026-11-23T06:00:00Z"))).toBe("2026-11-16");
    // A late run on the Sunday still states the week before the one in progress.
    expect(statementWeekFor(new Date("2026-11-29T23:00:00Z"))).toBe("2026-11-16");
  });

  jobTest("a school with nothing collected gets no statement, and nobody is told", async () => {
    const [school] = await db!<{ id: string }[]>`
      SELECT id::text AS id FROM app.schools ORDER BY created_at LIMIT 1
    `;
    if (!school) return;
    const result = await runAiRevenueShareStatements(
      db!,
      new Date("2026-11-23T06:00:00Z"),
      silentLogger,
      [school.id],
    );
    expect(result).toMatchObject({
      weekStart: "2026-11-16",
      schools: 1,
      statements: 0,
      failedSchools: 0,
      superAdminsNotified: 0,
    });
  });
});
