/**
 * Integration test: redaction against a real, disposable school fixture (never the seeded demo
 * tenant -- redaction is destructive). Skipped without TEST_DATABASE_URL.
 */
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { findRedactableColumns, redactPersonalColumns } from "./redact";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const dbTest = test.skipIf(!enabled);

let sql: Sql | undefined;
let schoolId: string;

async function seedFixtureSchool(): Promise<string> {
  const [country] = await sql!<{ id: string }[]>`SELECT id FROM app.countries LIMIT 1`;
  const [currency] = await sql!<{ id: string }[]>`SELECT id FROM app.currencies LIMIT 1`;
  const slug = "dsr-test-" + crypto.randomUUID().slice(0, 8);
  const [school] = await sql!<{ id: string }[]>`
    INSERT INTO app.schools (slug, name, status, country_id, default_currency_id, email, normalized_email)
    VALUES (
      ${slug}, 'DSR Redaction Fixture', 'active', ${country!.id}, ${currency!.id},
      ${slug + "@example.com"}, ${slug + "@example.com"}
    )
    RETURNING id
  `;
  return school!.id;
}

beforeAll(async () => {
  if (!enabled) return;
  // Connects as the compose superuser (POSTGRES_USER), which bypasses RLS -- fixture setup and
  // teardown do not need a tenant transaction, only redactPersonalColumns' own query does the
  // school-scoped filtering that matters here.
  // max: 1 -- the session-level set_config() below only survives on the exact physical connection
  // it ran on; a larger pool could hand a later query a connection that never saw it.
  sql = postgres(databaseUrl!, { max: 1, ssl: false, prepare: false });
  schoolId = await seedFixtureSchool();
  // Some tenant tables' triggers (e.g. app.seed_default_notification_preferences) read
  // current_setting('app.school_id') unconditionally. Superuser bypasses RLS itself, but not a GUC
  // lookup -- set it once, session-wide, for this connection's fixture inserts.
  await sql`SELECT set_config('app.school_id', ${schoolId}, false)`;
});

afterEach(async () => {
  if (!enabled) return;
  // Fresh users per test so redaction results from one test can't leak into the next.
  // app.seed_default_notification_preferences() gives every inserted user child rows under an
  // ON DELETE RESTRICT foreign key -- exactly the "nothing in this schema cascades" fact
  // retention-registry.ts's header cites as why erasure redacts instead of deleting, demonstrated
  // here by needing to clear the child table before the parent.
  await sql!`DELETE FROM app.notification_preferences WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.users WHERE school_id = ${schoolId}::uuid`;
});

afterAll(async () => {
  if (!enabled) return;
  await sql!`DELETE FROM app.schools WHERE id = ${schoolId}::uuid`;
  await sql?.end({ timeout: 5 });
});

async function insertFixtureUser(): Promise<string> {
  const [user] = await sql!<{ id: string }[]>`
    INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
    VALUES (
      ${schoolId}::uuid, 'jane.doe@example.com', 'jane.doe@example.com', 'Jane Doe', 'active'
    )
    RETURNING id
  `;
  return user!.id;
}

describe("findRedactableColumns", () => {
  dbTest("finds users' verified personal columns and nothing structural", async () => {
    const columns = await findRedactableColumns(sql!, "users");
    const names = columns.map((c) => c.columnName).sort();
    expect(names).toEqual(["display_name", "email", "normalized_email"]);
  });

  dbTest("is a clean no-op set for a table with no personal columns", async () => {
    const columns = await findRedactableColumns(sql!, "classes");
    expect(columns).toEqual([]);
  });
});

describe("redactPersonalColumns", () => {
  dbTest("redacts every matched column and satisfies every CHECK constraint on them", async () => {
    await insertFixtureUser();

    const outcome = await sql!.begin(async (tx) => {
      return redactPersonalColumns(tx, "users", schoolId);
    });

    expect(outcome.rowsAffected).toBe(1);
    expect(outcome.columns.sort()).toEqual(["display_name", "email", "normalized_email"]);

    const [row] = await sql!<
      { display_name: string | null; email: string; normalized_email: string }[]
    >`
      SELECT display_name, email, normalized_email FROM app.users WHERE school_id = ${schoolId}::uuid
    `;
    expect(row!.display_name).toBeNull();
    expect(row!.email).toStartWith("erased-");
    expect(row!.normalized_email).toStartWith("erased-");
    // ck_users_normalized_email: normalized_email must already be its own lower(btrim(...)) form.
    expect(row!.normalized_email).toBe(row!.normalized_email.toLowerCase());
  });

  dbTest("scoped to one subject leaves other users in the same school untouched", async () => {
    const targetId = await insertFixtureUser();
    const [other] = await sql!<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, 'other@example.com', 'other@example.com', 'Other Person', 'active')
      RETURNING id
    `;

    const outcome = await sql!.begin(async (tx) =>
      redactPersonalColumns(tx, "users", schoolId, { column: "id", value: targetId }),
    );
    expect(outcome.rowsAffected).toBe(1);

    const [untouched] = await sql!<{ display_name: string | null }[]>`
      SELECT display_name FROM app.users WHERE id = ${other!.id}::uuid
    `;
    expect(untouched!.display_name).toBe("Other Person");
  });

  dbTest("a table with no personal columns short-circuits to a reported no-op", async () => {
    const outcome = await sql!.begin(async (tx) => redactPersonalColumns(tx, "classes", schoolId));
    expect(outcome).toEqual({ table: "classes", columns: [], rowsAffected: 0 });
  });
});
