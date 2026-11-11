/**
 * The tenant-closure sweep against a real database: a school its administrator closed ("Delete
 * school", status `archived` with `closed_at`) gets the closure export, and the erasure once the
 * export has been complete for the retention hold; an open school gets nothing. Skipped (as a
 * `skipIf` test) unless TEST_DATABASE_URL points at a migrated database.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { CLOSURE_ERASURE_RETENTION_HOLD_DAYS, runTenantClosureSweep } from "./closure-sweep";

import type { BillingLogger } from "@studafy/billing";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const sweepTest = test.skipIf(!enabled);

let db: Sql | undefined;

const silentLogger: BillingLogger = { info: () => undefined, warn: () => undefined };

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

/** A school with one ORG_ADMIN (the closure requests are filed in their name). */
async function seedSchool(label: string, closed: boolean): Promise<string> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'JO') AS country,
        (SELECT id FROM app.currencies WHERE code = 'JOD') AS currency
    `;
    const slug = `closure-${label}-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Closure School ${slug}`}, ${`${slug}@admin.local`},
        ${`${slug}@admin.local`}, ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const email = `${slug}@owner.local`;
    const [admin] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${schoolId}::uuid, ${email}, ${email}, 'active')
      RETURNING id
    `;
    await tx`
      INSERT INTO app.user_roles (school_id, user_id, role)
      VALUES (${schoolId}::uuid, ${admin!.id}::uuid, 'ORG_ADMIN')
    `;
    if (closed) {
      await tx`
        UPDATE app.schools
           SET status = 'archived', closed_at = now(), closed_by = ${admin!.id}::uuid
         WHERE id = ${schoolId}::uuid
      `;
    }
    return schoolId;
  });
}

async function closureRequests(schoolId: string) {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return tx<{ id: string; request_type: string }[]>`
      SELECT id, request_type::text AS request_type FROM app.data_subject_requests
      WHERE school_id = ${schoolId}::uuid AND subject_scope = 'tenant'
      ORDER BY created_at
    `;
  });
}

async function completeExport(schoolId: string, daysAgo: number): Promise<void> {
  await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`
      UPDATE app.data_subject_requests
         SET status = 'completed',
             storage_key = coalesce(storage_key, 'exports/closure-test/manifest.json'),
             -- Backdated together, so the row stays consistent (completed after it was created).
             created_at = now() - make_interval(days => ${daysAgo + 1}),
             completed_at = now() - make_interval(days => ${daysAgo}),
             updated_at = now()
       WHERE school_id = ${schoolId}::uuid AND subject_scope = 'tenant' AND request_type = 'export'
    `;
  });
}

describe("tenant closure sweep", () => {
  sweepTest(
    "a school closed by its administrator is exported, then erased after the hold",
    async () => {
      const closed = await seedSchool("closed", true);
      const open = await seedSchool("open", false);
      const enqueued: { schoolId: string; kind: string }[] = [];
      const enqueue = async (job: { schoolId: string; requestId: string; kind: string }) => {
        enqueued.push({ schoolId: job.schoolId, kind: job.kind });
      };

      await runTenantClosureSweep(db!, new Date(), enqueue, silentLogger);
      expect((await closureRequests(closed)).map((r) => r.request_type)).toEqual(["export"]);
      expect((await closureRequests(open)).length).toBe(0);
      expect(enqueued.filter((job) => job.schoolId === closed)).toEqual([
        { schoolId: closed, kind: "export" },
      ]);

      // Inside the hold, nothing more is filed.
      await completeExport(closed, CLOSURE_ERASURE_RETENTION_HOLD_DAYS - 1);
      await runTenantClosureSweep(db!, new Date(), enqueue, silentLogger);
      expect((await closureRequests(closed)).map((r) => r.request_type)).toEqual(["export"]);

      // Once the hold has elapsed, the erasure follows, once.
      await completeExport(closed, CLOSURE_ERASURE_RETENTION_HOLD_DAYS + 1);
      await runTenantClosureSweep(db!, new Date(), enqueue, silentLogger);
      await runTenantClosureSweep(db!, new Date(), enqueue, silentLogger);
      expect((await closureRequests(closed)).map((r) => r.request_type)).toEqual([
        "export",
        "erasure",
      ]);
      expect(
        enqueued.filter((job) => job.schoolId === closed && job.kind === "erasure"),
      ).toHaveLength(1);
      expect((await closureRequests(open)).length).toBe(0);
    },
  );
});
