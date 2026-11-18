/**
 * QA-014 / migration 000240: app.resolve_email_delivery_schools, the email-feedback lookup seam.
 *
 * The seam is the one place a delivery row is visible without its tenant armed, so it must stay
 * exactly as narrow as it claims: school ids only, only for the named message, nothing for an empty
 * id, executable by studafy_app (never PUBLIC), and nothing left armed for the rest of the caller's
 * transaction afterwards.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/email/delivery-lookup.db.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createSchool,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
const messageId = `msg-${crypto.randomUUID()}`;
const otherMessageId = `msg-${crypto.randomUUID()}`;
const schools: string[] = [];

/** One delivery row for `message` in `schoolId`, inserted as the table owner. */
async function delivery(schoolId: string, message: string): Promise<void> {
  const user = await createUser(database!.sql, schoolId);
  await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [event] = await tx<{ id: string }[]>`
      INSERT INTO app.outbox_events (school_id, event_name, payload)
      VALUES (${schoolId}::uuid, 'invitation.sent', '{}'::jsonb)
      RETURNING id
    `;
    await tx`
      INSERT INTO app.email_deliveries (school_id, outbox_event_id, recipient, template, status, message_id)
      VALUES (${schoolId}::uuid, ${event!.id}, ${user.email.toLowerCase()}, 'invitation', 'sent', ${message})
    `;
  });
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  for (let i = 0; i < 3; i++) schools.push((await createSchool(database.sql)).id);
  await delivery(schools[0]!, messageId);
  await delivery(schools[1]!, messageId);
  await delivery(schools[2]!, otherMessageId);
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

async function asApp<T>(run: (tx: import("postgres").TransactionSql) => Promise<T>): Promise<T> {
  return database!.sql.begin(async (tx) => {
    await tx`SELECT set_config('role', 'studafy_app', true)`;
    return run(tx);
  }) as Promise<T>;
}

describeDb("app.resolve_email_delivery_schools (QA-014)", () => {
  test("returns exactly the schools holding the named message, as studafy_app", async () => {
    const rows = await asApp(
      (tx) => tx<{ school_id: string }[]>`
        SELECT school_id FROM app.resolve_email_delivery_schools(${messageId}) AS school_id
      `,
    );
    expect(rows.map((r) => r.school_id).sort()).toEqual([schools[0]!, schools[1]!].sort());
  });

  test("refuses an empty or untrimmed message id", async () => {
    for (const bad of ["", ` ${messageId}`]) {
      let refused = false;
      try {
        await asApp((tx) => tx`SELECT app.resolve_email_delivery_schools(${bad})`);
      } catch {
        refused = true;
      }
      expect(`${JSON.stringify(bad)} refused: ${refused}`).toBe(
        `${JSON.stringify(bad)} refused: true`,
      );
    }
  });

  test("leaves nothing armed: the caller's school scope and the lookup setting are restored", async () => {
    const after = await asApp(async (tx) => {
      await tx`SELECT set_config('app.school_id', ${schools[2]!}, true)`;
      await tx`SELECT app.resolve_email_delivery_schools(${messageId})`;
      const [state] = await tx<{ school: string; lookup: string | null }[]>`
        SELECT current_setting('app.school_id', true) AS school,
               current_setting('app.email_delivery_message', true) AS lookup
      `;
      // With school C still armed, the table shows C's row only -- never A's or B's.
      const visible = await tx<{ school_id: string }[]>`
        SELECT school_id FROM app.email_deliveries
      `;
      return { ...state!, visible: visible.map((r) => r.school_id) };
    });
    expect(after.school).toBe(schools[2]!);
    expect(after.lookup ?? "").toBe("");
    expect([...new Set(after.visible)]).toEqual([schools[2]!]);
  });

  test("is not executable by PUBLIC", async () => {
    const [row] = await database!.sql<{ public_exec: boolean }[]>`
      SELECT bool_or(acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_exec
      FROM pg_proc p, aclexplode(p.proacl) acl
      WHERE p.proname = 'resolve_email_delivery_schools'
    `;
    expect(row?.public_exec ?? false).toBe(false);
  });
});
