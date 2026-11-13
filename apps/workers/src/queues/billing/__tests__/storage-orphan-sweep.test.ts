/**
 * The orphaned-file report inside the daily storage reconciliation, against a real database.
 *
 * An orphan is a permanent/<school>/ object at least a week old that no row points at
 * (app.referenced_storage_keys, 000204). By default the sweep only counts them; with removal
 * enabled it deletes them and leaves their bytes out of the meter. A referenced file, a recent
 * file and a file the listing gave no age for are never touched. Skipped unless TEST_DATABASE_URL
 * is set (and migrated).
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { orphanRemovalEnabled } from "../storage-orphan-sweep";
import { runStorageQuotaReconciliation } from "../storage-quota-reconciliation";

import type { StorageQuotaS3Client, StorageQuotaS3Object } from "../storage-quota-s3";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const dbTest = test.skipIf(!enabled);

let db: Sql | undefined;
const silentLogger = { info: () => undefined, warn: () => undefined };
const NOW = new Date("2026-11-12T06:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

class FakeStorage implements StorageQuotaS3Client {
  objects = new Map<string, StorageQuotaS3Object>();
  removed: string[] = [];

  put(key: string, sizeBytes: number, ageDays: number | null): void {
    this.objects.set(key, {
      key,
      sizeBytes,
      ...(ageDays === null ? {} : { lastModified: new Date(NOW.getTime() - ageDays * DAY) }),
    });
  }

  async *list(prefix: string) {
    for (const object of this.objects.values()) {
      if (object.key.startsWith(prefix)) yield object;
    }
  }

  async remove(key: string) {
    this.removed.push(key);
    this.objects.delete(key);
  }
}

async function seedSchoolWithExpenseKey(key: (schoolId: string) => string): Promise<string> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const slug = `orphan-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Orphan School ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`
      INSERT INTO app.expense_cache (
        school_id, document_type, category, vendor, currency_id, amount_minor,
        erpnext_docname, erpnext_status, last_synced_at, attachment_storage_key
      ) VALUES (
        ${schoolId}, 'expense_claim', 'Supplies', 'Stationer', ${reference!.currency}, 100,
        ${`EXP-${slug}`}, 'Draft', CURRENT_TIMESTAMP, ${key(schoolId)}
      )
    `;
    return schoolId;
  });
}

/** What the API writes when an expense's receipt is replaced: the old key, kept as a record. */
async function auditReplacedReceipt(schoolId: string, key: string): Promise<void> {
  await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`
      INSERT INTO app.audit_logs (school_id, action, target_table, target_id, old_values, new_values)
      VALUES (
        ${schoolId}::uuid, 'update', 'expense_cache', gen_random_uuid(),
        ${tx.json({ attachment_storage_key: key })}, ${tx.json({ attachment_storage_key: "x" })}
      )
    `;
  });
}

async function readMeterBytes(schoolId: string): Promise<number> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<{ bytes_used: string }[]>`
      SELECT bytes_used::text AS bytes_used FROM app.storage_usage_meters
      WHERE school_id = ${schoolId}::uuid
    `;
    return Number(row?.bytes_used ?? 0);
  });
}

function world(schoolId: string): { storage: FakeStorage; keys: Record<string, string> } {
  const keys = {
    referenced: `permanent/${schoolId}/receipt/r.pdf`,
    orphan: `permanent/${schoolId}/old/gone.pdf`,
    recent: `permanent/${schoolId}/new/fresh.pdf`,
    undated: `permanent/${schoolId}/undated/u.pdf`,
    replacedReceipt: `permanent/${schoolId}/old-receipt/r0.pdf`,
  };
  const storage = new FakeStorage();
  storage.put(keys.referenced, 1_000, 30);
  storage.put(keys.orphan, 2_000, 30);
  storage.put(keys.recent, 4_000, 1);
  storage.put(keys.undated, 8_000, null);
  storage.put(keys.replacedReceipt, 500, 30);
  return { storage, keys };
}

describe("orphaned files in the storage reconciliation", () => {
  dbTest("reports old unreferenced files and removes nothing by default", async () => {
    const schoolId = await seedSchoolWithExpenseKey((id) => `permanent/${id}/receipt/r.pdf`);
    const { storage, keys } = world(schoolId);
    await auditReplacedReceipt(schoolId, keys.replacedReceipt!);

    const result = await runStorageQuotaReconciliation(db!, storage, silentLogger, { now: NOW });

    expect(result.orphans).toBeGreaterThanOrEqual(1);
    expect(result.orphansRemoved).toBe(0);
    expect(storage.removed).toEqual([]);
    expect(storage.objects.has(keys.orphan!)).toBe(true);
    expect(await readMeterBytes(schoolId)).toBe(15_500);
  });

  dbTest(
    "with removal enabled deletes only the orphan and leaves it out of the meter",
    async () => {
      const schoolId = await seedSchoolWithExpenseKey((id) => `permanent/${id}/receipt/r.pdf`);
      const { storage, keys } = world(schoolId);
      await auditReplacedReceipt(schoolId, keys.replacedReceipt!);

      await runStorageQuotaReconciliation(db!, storage, silentLogger, {
        now: NOW,
        removeOrphans: true,
      });

      expect(storage.removed).toEqual([keys.orphan!]);
      expect(storage.objects.has(keys.referenced!)).toBe(true);
      expect(storage.objects.has(keys.recent!)).toBe(true);
      expect(storage.objects.has(keys.undated!)).toBe(true);
      // A replaced receipt named in a finance audit row is a kept finance record.
      expect(storage.objects.has(keys.replacedReceipt!)).toBe(true);
      expect(await readMeterBytes(schoolId)).toBe(13_500);
    },
  );
});

describe("orphan removal switch", () => {
  test("is off unless STORAGE_ORPHAN_REMOVAL is exactly 'enabled'", () => {
    expect(orphanRemovalEnabled({})).toBe(false);
    expect(orphanRemovalEnabled({ STORAGE_ORPHAN_REMOVAL: "true" })).toBe(false);
    expect(orphanRemovalEnabled({ STORAGE_ORPHAN_REMOVAL: "enabled" })).toBe(true);
  });
});
