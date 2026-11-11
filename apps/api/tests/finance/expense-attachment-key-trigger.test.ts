/**
 * Migration 000197's trigger: an expense row cannot be written with another school's attachment key,
 * its own school's key is accepted, and a row saved before the trigger existed (simulated by
 * disabling it for one insert) can still be updated in other columns, such as its scan status.
 * Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createFullTenant,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestDatabase } from "../harness";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

async function asAdmin<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

function insertExpense(tx: TransactionSql, schoolId: string, docname: string, key: string) {
  return tx`
    INSERT INTO app.expense_cache (
      school_id, document_type, category, vendor, currency_id, amount_minor, erpnext_docname,
      erpnext_status, attachment_storage_key, last_synced_at
    ) VALUES (
      ${schoolId}::uuid, 'purchase_invoice', 'supplies', 'Acme',
      (SELECT id FROM app.currencies WHERE code = 'USD'), 5000, ${docname}, 'Submitted',
      ${key}, now()
    )
  `;
}

describeDb("expense attachment key trigger (000197)", () => {
  test("refuses another school's key, accepts the school's own, and leaves old rows updatable", async () => {
    const school = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);
    const object = crypto.randomUUID();
    const foreignKey = `permanent/${other.schoolId}/${object}/receipt.pdf`;
    const ownKey = `permanent/${school.schoolId}/${object}/receipt.pdf`;

    await expect(
      asAdmin(school.schoolId, (tx) =>
        insertExpense(tx, school.schoolId, "ACC-FOREIGN", foreignKey),
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await asAdmin(school.schoolId, (tx) => insertExpense(tx, school.schoolId, "ACC-OWN", ownKey));
    await expect(
      asAdmin(
        school.schoolId,
        (tx) =>
          tx`UPDATE app.expense_cache SET attachment_storage_key = ${foreignKey}
            WHERE school_id = ${school.schoolId}::uuid AND erpnext_docname = 'ACC-OWN'`,
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // A row from before the trigger: other columns can still change (the scanner marks it failed).
    await asAdmin(school.schoolId, async (tx) => {
      await tx.unsafe(
        "ALTER TABLE app.expense_cache DISABLE TRIGGER trg_expense_cache_attachment_key_school",
      );
      await insertExpense(tx, school.schoolId, "ACC-LEGACY", foreignKey);
      await tx.unsafe(
        "ALTER TABLE app.expense_cache ENABLE TRIGGER trg_expense_cache_attachment_key_school",
      );
    });
    await asAdmin(
      school.schoolId,
      (tx) =>
        tx`UPDATE app.expense_cache SET attachment_scan_status = 'failed'
          WHERE school_id = ${school.schoolId}::uuid AND erpnext_docname = 'ACC-LEGACY'`,
    );
  });
});
