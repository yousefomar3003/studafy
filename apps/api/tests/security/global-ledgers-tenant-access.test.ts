/**
 * QA-017: a tenant transaction cannot read the global email and security ledgers.
 *
 * studafy_app held SELECT on app.email_events and app.email_suppressions (every school's recipient
 * addresses and delivery events) and on app.security_events (client IPs and user agents of
 * rejected requests). Any tenant transaction could read them all. The runtime role now only
 * INSERTs into them (the webhook and the security-event sink); reads happen in system
 * transactions (the platform health page, the retention sweeps, the email dispatcher).
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/security/global-ledgers-tenant-access.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTx } from "../../src/db/tenant-tx";
import {
  appDatabaseFor,
  createSchool,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let schoolA: string;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  schoolA = (await createSchool(database.sql)).id;
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

describeDb("global ledgers from a tenant transaction (QA-017)", () => {
  for (const table of ["email_events", "email_suppressions", "security_events"]) {
    test(`school A cannot read app.${table}`, async () => {
      const outcome = await withTenantTx(
        appDatabaseFor(database!.sql),
        { schoolId: schoolA },
        (tx) => tx.unsafe(`SELECT count(*) FROM app.${table}`),
      ).then(
        () => "read",
        (error: unknown) =>
          String(error).includes("permission denied") ? "denied" : String(error),
      );
      expect(outcome).toBe("denied");
    });
  }
});
