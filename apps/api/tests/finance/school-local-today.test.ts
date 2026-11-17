/**
 * QA-044: finance and billing dates are the school's own "today", not UTC's.
 *
 * Posting, reference and expense dates defaulted to `new Date().toISOString().slice(0, 10)` and
 * overdue checks compared with `CURRENT_DATE`, both UTC. Studafy's schools are UTC+1 to UTC+4: a
 * payment at 01:30 in Riyadh was dated the previous day, breaking daily reconciliation and
 * month-end periods, and invoices turned overdue hours late. `app.school_today()` (migration
 * 000236) is the school-local date; every such site now uses it.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/finance/school-local-today.test.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createSchool, createTestDatabase, integrationEnabled, migrateDatabase } from "../harness";

import type { TestDatabase } from "../harness";

const root = join(import.meta.dir, "../../../..");
const describeDb = integrationEnabled ? describe : describe.skip;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("no UTC 'today' in finance and billing (QA-044)", () => {
  const files = [
    ...sources(join(root, "apps/api/src/modules/finance")),
    ...sources(join(root, "apps/workers/src/queues/billing")),
  ];

  test("no request-time date is taken from UTC", () => {
    const offenders = files.filter((file) =>
      /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((file) => file.slice(root.length + 1))).toEqual([]);
  });

  test("no SQL compares against CURRENT_DATE", () => {
    const offenders = files.filter((file) => /\bCURRENT_DATE\b/.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => file.slice(root.length + 1))).toEqual([]);
  });
});

let database: TestDatabase | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

async function todayAt(timezone: string, nowIso: string): Promise<string> {
  const school = await createSchool(database!.sql);
  return database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${school.id}, true)`;
    await tx`
      INSERT INTO app.school_settings (school_id, timezone) VALUES (${school.id}::uuid, ${timezone})
      ON CONFLICT (school_id) DO UPDATE SET timezone = EXCLUDED.timezone
    `;
    const [row] = await tx<{ today: string }[]>`
      SELECT app.school_today(${nowIso}::timestamptz)::text AS today
    `;
    return row!.today;
  });
}

describeDb("app.school_today (QA-044)", () => {
  test("22:30 UTC on 31 March is already 1 April in Riyadh and Dubai", async () => {
    expect(await todayAt("Asia/Riyadh", "2026-03-31T22:30:00Z")).toBe("2026-04-01");
    expect(await todayAt("Asia/Dubai", "2026-03-31T22:30:00Z")).toBe("2026-04-01");
  });

  test("Cairo, outside and inside daylight saving time", async () => {
    expect(await todayAt("Africa/Cairo", "2026-01-01T21:30:00Z")).toBe("2026-01-01");
    expect(await todayAt("Africa/Cairo", "2026-01-01T22:30:00Z")).toBe("2026-01-02");
    expect(await todayAt("Africa/Cairo", "2026-07-01T21:30:00Z")).toBe("2026-07-02");
  });
});
