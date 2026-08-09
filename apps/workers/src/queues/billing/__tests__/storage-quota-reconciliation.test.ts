/**
 * The storage-quota reconciliation sweep (ST-16x), against a real database.
 *
 * Seeds schools with stale app.storage_usage_meters rows and drives the sweep with an in-memory
 * fake S3 client, so no network is touched and every byte is deterministic. The acceptance the
 * tests prove: the meter is replaced with the exact sum of the school's *counted* prefixes
 * (permanent/, reports/, legacy tenant-<schoolId>/reports/) — decoys under temp/ or under another
 * school's prefix never count — and a failing school rolls back and is counted without stopping
 * the schools after it. Skipped (as `skipIf` tests) unless TEST_DATABASE_URL is set.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { runStorageQuotaReconciliation } from "../storage-quota-reconciliation";

import type { StorageQuotaS3Client } from "../storage-quota-s3";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const storageTest = test.skipIf(!enabled);

let db: Sql | undefined;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
};

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

class FakeStorage implements StorageQuotaS3Client {
  /** key -> sizeBytes. */
  objects: Record<string, number> = {};
  /** Prefixes whose listing should throw (the "S3 unavailable" failure case). */
  failFor = new Set<string>();

  async *list(prefix: string) {
    if (this.failFor.has(prefix)) throw new Error("s3 unavailable");
    for (const [key, sizeBytes] of Object.entries(this.objects)) {
      if (key.startsWith(prefix)) yield { key, sizeBytes };
    }
  }
}

async function seedSchool(): Promise<string> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;

    const slug = `storage-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Storage School ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const schoolId = school!.id;

    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    return schoolId;
  });
}

async function setMeterBytes(schoolId: string, bytesUsed: number): Promise<void> {
  await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`
      INSERT INTO app.storage_usage_meters (school_id, bytes_used)
      VALUES (${schoolId}::uuid, ${bytesUsed})
      ON CONFLICT (school_id) DO UPDATE SET bytes_used = EXCLUDED.bytes_used
    `;
  });
}

async function readMeterBytes(schoolId: string): Promise<number> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<{ bytes_used: string }[]>`
      SELECT bytes_used::text AS bytes_used FROM app.storage_usage_meters WHERE school_id = ${schoolId}::uuid
    `;
    return Number(row!.bytes_used);
  });
}

/** The sum a school's *counted* prefixes should measure for the given object set. */
function countedBytes(schoolId: string, objects: Record<string, number>): number {
  const prefixes = [
    `permanent/${schoolId}/`,
    `reports/${schoolId}/`,
    `tenant-${schoolId}/reports/`,
  ];
  return Object.entries(objects).reduce(
    (sum, [key, size]) => (prefixes.some((p) => key.startsWith(p)) ? sum + size : sum),
    0,
  );
}

describe("storage quota reconciliation sweep", () => {
  storageTest(
    "replaces the meter with the exact bucket footprint and ignores non-counted prefixes",
    async () => {
      const schoolId = await seedSchool();
      await setMeterBytes(schoolId, 1_000_000);

      const storage = new FakeStorage();
      storage.objects = {
        [`permanent/${schoolId}/a.pdf`]: 2048,
        [`permanent/${schoolId}/sub/b.bin`]: 512,
        [`reports/${schoolId}/r.pdf`]: 256,
        [`tenant-${schoolId}/reports/fr.pdf`]: 128,
        // Decoys: temp/ is never metered, and another school's bytes are not this school's.
        [`temp/${schoolId}/t.bin`]: 999_999,
        [`quarantine/${schoolId}/q.bin`]: 888_888,
        [`permanent/other-school/u.bin`]: 777_777,
      };

      const result = await runStorageQuotaReconciliation(db!, storage, silentLogger);
      expect(result.corrected).toBeGreaterThanOrEqual(1);
      expect(result.bytesMeasured).toBeGreaterThan(0);

      expect(await readMeterBytes(schoolId)).toBe(countedBytes(schoolId, storage.objects));
    },
  );

  storageTest("leaves an already-accurate meter untouched", async () => {
    const schoolId = await seedSchool();
    const storage = new FakeStorage();
    storage.objects = {
      [`permanent/${schoolId}/a.pdf`]: 2048,
      [`reports/${schoolId}/r.pdf`]: 256,
    };
    const expected = countedBytes(schoolId, storage.objects);
    await setMeterBytes(schoolId, expected);

    const result = await runStorageQuotaReconciliation(db!, storage, silentLogger);
    expect(result.bytesMeasured).toBeGreaterThan(0);

    expect(await readMeterBytes(schoolId)).toBe(expected);
  });

  storageTest(
    "a school whose bucket listing fails keeps its stale meter without stopping the schools after it",
    async () => {
      const [first, second] = [await seedSchool(), await seedSchool()];
      await setMeterBytes(first, 1234);
      await setMeterBytes(second, 9876);

      const storage = new FakeStorage();
      storage.objects = {
        [`permanent/${first}/a.pdf`]: 100,
        [`permanent/${second}/b.pdf`]: 500,
      };
      storage.failFor.add(`permanent/${first}/`);

      const result = await runStorageQuotaReconciliation(db!, storage, silentLogger);
      expect(result.failed).toBeGreaterThanOrEqual(1);

      expect(await readMeterBytes(first)).toBe(1234);
      expect(await readMeterBytes(second)).toBe(500);
    },
  );
});
