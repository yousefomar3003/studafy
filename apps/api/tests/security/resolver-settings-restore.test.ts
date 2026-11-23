/**
 * QA-018: a SECURITY DEFINER lookup leaves the transaction as it found it.
 *
 * The login and lookup resolvers (000031, 000034, 000115, 000141) arm a transaction-local setting
 * that switches on a permissive lookup policy (`app.deletion_request_email`,
 * `app.invitation_token_hash`, `app.oauth_login_*`) and overwrite `app.school_id`, and never put
 * either back. A caller that ran more queries in the same transaction would keep matching other
 * schools' rows through that policy. Each resolver now restores every setting it touched.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/security/resolver-settings-restore.test.ts
 */

import { createHash } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTx } from "../../src/db/tenant-tx";
import {
  appDatabaseFor,
  createSchool,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;
const SHARED_EMAIL = "same.person@example.test";

let database: TestDatabase | undefined;
let schoolA: string;
let schoolB: string;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  schoolA = (await createSchool(database.sql)).id;
  schoolB = (await createSchool(database.sql)).id;
  await createUser(database.sql, schoolA, { email: SHARED_EMAIL });
  await createUser(database.sql, schoolB, { email: SHARED_EMAIL });
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

/** Inside school A's transaction: run `call`, then report what the transaction can still see. */
function afterResolver(call: string) {
  return withTenantTx(appDatabaseFor(database!.sql), { schoolId: schoolA }, async (tx) => {
    await tx.unsafe(call);
    const [state] = await tx<
      { school: string; deletion: string; invitation: string; provider: string; subject: string }[]
    >`
      SELECT current_setting('app.school_id', true) AS school,
             coalesce(current_setting('app.deletion_request_email', true), '') AS deletion,
             coalesce(current_setting('app.invitation_token_hash', true), '') AS invitation,
             coalesce(current_setting('app.oauth_login_provider', true), '') AS provider,
             coalesce(current_setting('app.oauth_login_subject', true), '') AS subject
    `;
    const users = await tx<{ school_id: string }[]>`
      SELECT school_id::text FROM app.users WHERE normalized_email = ${SHARED_EMAIL}
    `;
    return { state: state!, schools: users.map((user) => user.school_id) };
  });
}

describeDb("resolver settings are restored (QA-018)", () => {
  test("after a deletion-request lookup, school A sees only its own user", async () => {
    const { state, schools } = await afterResolver(
      `SELECT * FROM app.resolve_accounts_for_deletion_request('${SHARED_EMAIL}')`,
    );
    expect(schools).toEqual([schoolA]);
    expect(state.school).toBe(schoolA);
    expect(state.deletion).toBe("");
  });

  test("after an invitation lookup, the token setting is cleared and the tenant restored", async () => {
    const digest = createHash("sha256").update("token").digest("hex");
    const { state } = await afterResolver(
      `SELECT * FROM app.lookup_invitation_for_verification(decode('${digest}', 'hex'))`,
    );
    expect([state.school, state.invitation]).toEqual([schoolA, ""]);
  });

  test("after an OAuth identity lookup, provider and subject are cleared", async () => {
    const { state } = await afterResolver(
      "SELECT * FROM app.resolve_oauth_identity_for_login('google', 'subject-1')",
    );
    expect([state.school, state.provider, state.subject]).toEqual([schoolA, "", ""]);
  });

  test("after releasing an inactive identity, school A sees only its own user again", async () => {
    const { state, schools } = await afterResolver(
      "SELECT * FROM app.release_inactive_oauth_identity('google', 'subject-1')",
    );
    expect(schools).toEqual([schoolA]);
    expect([state.school, state.provider, state.subject]).toEqual([schoolA, "", ""]);
  });

  test("after a member-code lookup, the caller's school is armed again", async () => {
    const { state } = await afterResolver(
      "SELECT * FROM app.resolve_member_code_for_login('STU-1000001')",
    );
    expect(state.school).toBe(schoolA);
  });
});
