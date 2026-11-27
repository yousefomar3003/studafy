/**
 * scripts/backfill-erpnext-sites.ts: the missing `pending` site row for every approved school,
 * written by provisioning's own registerErpNextSite. Dry run by default, idempotent with --apply.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/erpnext/backfill-erpnext-sites.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { backfillErpNextSites } from "../../scripts/backfill-erpnext-sites";
import { createLogger } from "../../src/logger";
import { erpNextSiteName } from "../../src/modules/tenancy/provisioning/service";
import {
  appDatabaseFor,
  createSchool,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  registerPlatformSchool,
} from "../harness";

import type { SchoolRecord, TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;
const logger = createLogger({ destination: () => undefined });

let db: TestDatabase;
const schools = {} as Record<"missing" | "registered" | "unapproved" | "platform", SchoolRecord>;

async function setStatus(schoolId: string, status: string): Promise<void> {
  await db.sql`UPDATE app.schools SET status = ${status}::app.school_status WHERE id = ${schoolId}::uuid`;
}

async function siteRows() {
  return db.sql<
    {
      school_id: string;
      site_name: string;
      company_name: string;
      company_abbr: string;
      status: string;
    }[]
  >`
    SELECT school_id, site_name, company_name, company_abbr, status::text AS status
    FROM app.erpnext_site_configs ORDER BY site_name
  `;
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  const suffix = crypto.randomUUID().slice(0, 6);

  schools.missing = await createSchool(db.sql, {
    slug: `al-noor-${suffix}`,
    name: "Al Noor School",
  });
  schools.registered = await createSchool(db.sql);
  schools.unapproved = await createSchool(db.sql);
  schools.platform = await createSchool(db.sql);
  await setStatus(schools.missing.id, "active");
  await setStatus(schools.registered.id, "active");
  await setStatus(schools.platform.id, "active");
  await registerPlatformSchool(db.sql, schools.platform.id);
  await db.sql`
    INSERT INTO app.erpnext_site_configs (school_id, site_name, company_name, company_abbr, status)
    VALUES (${schools.registered.id}::uuid, 'existing.erpnext.test', 'Existing', 'EXIS', 'completed')
  `;
}, 120_000);

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

describeDb("backfill-erpnext-sites", () => {
  test("dry run: counts the approved school without a row, writes nothing", async () => {
    const result = await backfillErpNextSites(appDatabaseFor(db.sql), { apply: false, logger });

    expect(result.approved).toBe(2);
    expect(result.alreadyRegistered).toBe(1);
    expect(result.missing.map((s) => s.id)).toEqual([schools.missing.id]);
    expect(result.written).toBe(0);
    expect((await siteRows()).map((r) => r.school_id)).toEqual([schools.registered.id]);
  });

  test("--apply: writes the same pending row provisioning writes", async () => {
    const result = await backfillErpNextSites(appDatabaseFor(db.sql), { apply: true, logger });

    expect(result.written).toBe(1);
    const row = (await siteRows()).find((r) => r.school_id === schools.missing.id);
    expect(row).toEqual({
      school_id: schools.missing.id,
      site_name: erpNextSiteName(schools.missing.slug),
      company_name: "Al Noor School",
      company_abbr: "ALNO",
      status: "pending",
    });
    // The existing row is left exactly as it was.
    expect((await siteRows()).find((r) => r.school_id === schools.registered.id)?.status).toBe(
      "completed",
    );
  });

  test("idempotent: a second --apply writes nothing", async () => {
    const result = await backfillErpNextSites(appDatabaseFor(db.sql), { apply: true, logger });

    expect(result).toEqual({ approved: 2, alreadyRegistered: 2, missing: [], written: 0 });
    expect(await siteRows()).toHaveLength(2);
  });
});
