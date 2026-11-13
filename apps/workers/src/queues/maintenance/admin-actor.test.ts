// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { armAdminActor, NoAdminActorError, resolveAdminActor } from "./admin-actor";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const dbTest = test.skipIf(!enabled);

let sql: Sql | undefined;
let schoolId: string;

beforeAll(async () => {
  if (!enabled) return;
  // max: 1 -- app.school_id below is a session-level set_config(), which only survives on the exact
  // physical connection it ran on. A larger pool could hand a later query a different connection
  // that never saw it.
  sql = postgres(databaseUrl!, { max: 1, ssl: false, prepare: false });
  const [country] = await sql<{ id: string }[]>`SELECT id FROM app.countries LIMIT 1`;
  const [currency] = await sql<{ id: string }[]>`SELECT id FROM app.currencies LIMIT 1`;
  const slug = "dsr-admin-actor-test-" + crypto.randomUUID().slice(0, 8);
  const [school] = await sql<{ id: string }[]>`
    INSERT INTO app.schools (slug, name, status, country_id, default_currency_id, email, normalized_email)
    VALUES (
      ${slug}, 'DSR Admin Actor Fixture', 'active', ${country!.id}, ${currency!.id},
      ${slug + "@example.com"}, ${slug + "@example.com"}
    )
    RETURNING id
  `;
  schoolId = school!.id;
  await sql`SELECT set_config('app.school_id', ${schoolId}, false)`;
});

afterAll(async () => {
  if (!enabled) return;
  await sql!`DELETE FROM app.notification_preferences WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.user_roles WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.users WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.schools WHERE id = ${schoolId}::uuid`;
  await sql?.end({ timeout: 5 });
});

describe("resolveAdminActor", () => {
  dbTest("throws NoAdminActorError when the school has no admin at all", async () => {
    let caught: unknown;
    await sql!.begin(async (tx) => {
      try {
        await resolveAdminActor(tx, schoolId);
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(NoAdminActorError);
  });

  dbTest("resolves the ORG_ADMIN and arms app.user_id for role-scoped reads", async () => {
    const [user] = await sql!<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, 'admin@example.com', 'admin@example.com', 'Admin Fixture', 'active')
      RETURNING id
    `;
    await sql!`
      INSERT INTO app.user_roles (school_id, user_id, role) VALUES (${schoolId}::uuid, ${user!.id}::uuid, 'ORG_ADMIN')
    `;

    let resolvedId: string | undefined;
    let armedCurrentSetting: string | undefined;
    await sql!.begin(async (tx) => {
      resolvedId = await resolveAdminActor(tx, schoolId);
      await armAdminActor(tx, resolvedId);
      const [row] = await tx<
        { current: string }[]
      >`SELECT current_setting('app.user_id') AS current`;
      armedCurrentSetting = row!.current;
    });

    expect(resolvedId).toBe(user!.id);
    expect(armedCurrentSetting).toBe(user!.id);
  });
});
