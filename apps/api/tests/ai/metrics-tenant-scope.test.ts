/**
 * QA-062: the platform AI metrics console reports every school's usage.
 *
 * It read app.ai_subscriptions -- FORCE row-level security keyed on app.school_id -- in a system
 * transaction with no school armed, which (as db/tenant-tx.ts warns) matches zero rows under a
 * login without RLS bypass: the console could only ever show an empty table. It now reads each
 * school under its own scope (pipelinePerSchool).
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/ai/metrics-tenant-scope.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { loadAiTenantRows } from "../../src/modules/ai/routes/metrics-routes";
import {
  appDatabaseFor,
  createSchool,
  createStudent,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
const schools: string[] = [];

async function seedSchoolWithUsage(tokens: number): Promise<string> {
  const school = await createSchool(database!.sql);
  const student = await createStudent(database!.sql, school.id);
  await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${school.id}, true)`;
    const [sub] = await tx<{ id: string }[]>`
      INSERT INTO app.ai_subscriptions
        (school_id, student_id, status, current_period_start, current_period_end)
      VALUES (${school.id}::uuid, ${student.id}::uuid, 'active',
              now() - interval '1 day', now() + interval '29 days')
      RETURNING id
    `;
    await tx`
      INSERT INTO app.ai_usage_meters
        (school_id, student_id, ai_subscription_id, total_tokens, small_tokens, large_tokens)
      VALUES (${school.id}::uuid, ${student.id}::uuid, ${sub!.id}::uuid, ${tokens}, ${tokens}, 0)
    `;
  });
  return school.id;
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  schools.push(await seedSchoolWithUsage(1200), await seedSchoolWithUsage(3400));
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

describeDb("AI metrics console (QA-062)", () => {
  test("reports each school's subscribed students and tokens", async () => {
    const rows = await loadAiTenantRows(appDatabaseFor(database!.sql));
    const bySchool = new Map(rows.map((row) => [row.school_id, row]));
    expect(bySchool.get(schools[0]!)?.subscribed_students).toBe(1);
    expect(Number(bySchool.get(schools[0]!)?.total_tokens)).toBe(1200);
    expect(Number(bySchool.get(schools[1]!)?.total_tokens)).toBe(3400);
  });
});
