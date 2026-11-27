/**
 * Writes the missing `pending` ERPNext site row for every approved school (docs/plans/erpnext-fly.md).
 *
 * Every school approved while ERPNext was unconfigured skipped `registerErpNextSite`, so it has no
 * app.erpnext_site_configs row and the site agent never creates its site. This writes that row with
 * the very same function provisioning uses (same site name, same company abbreviation). Run once
 * after the first deploy that configures ERPNext; the agent then creates the sites one at a time.
 *
 * "Approved" is a school whose status is `active`; the platform school (Studafy's own staff) has no
 * finance and is skipped. Dry run by default: it prints what it would write. `--apply` writes.
 * Idempotent: a school that has a row is left alone (`ON CONFLICT (school_id) DO NOTHING`), so a
 * second run writes nothing.
 *
 * Connects with the API's own DATABASE_* settings and ERPNEXT_SITE_DOMAIN. The API build bundles it
 * to dist/backfill-erpnext-sites.js, so it runs in the API container:
 *
 *   fly ssh console -a studafy-core-api -C "bun dist/backfill-erpnext-sites.js"          # dry run
 *   fly ssh console -a studafy-core-api -C "bun dist/backfill-erpnext-sites.js --apply"
 *
 * Locally: bun --env-file=.env apps/api/scripts/backfill-erpnext-sites.ts [--apply]
 */

import { createDatabase } from "../src/db/client";
import { pipelinePerSchool, withSystemTx } from "../src/db/tenant-tx";
import { loadEnv } from "../src/env";
import { createLogger } from "../src/logger";
import { erpNextSiteName, registerErpNextSite } from "../src/modules/tenancy/provisioning/service";

import type { Database } from "../src/db/client";
import type { Logger } from "../src/logger";

interface ApprovedSchool {
  id: string;
  slug: string;
  name: string;
}

export interface BackfillResult {
  /** Approved (active, non-platform) schools. */
  approved: number;
  /** Of those, schools that already had a site row. */
  alreadyRegistered: number;
  /** Schools missing a row: the ones written, or that --apply would write. */
  missing: ApprovedSchool[];
  /** Rows actually written (0 on a dry run). */
  written: number;
}

/** Approved schools with no app.erpnext_site_configs row, one school's scope at a time. */
async function findMissing(
  database: Database,
): Promise<{ approved: ApprovedSchool[]; missing: ApprovedSchool[] }> {
  return withSystemTx(database, async (tx) => {
    const approved = await tx<ApprovedSchool[]>`
      SELECT id, slug, name
      FROM app.schools
      WHERE status = 'active' AND NOT is_platform_tenant
      ORDER BY created_at, id
    `;
    const perSchool = await pipelinePerSchool(tx, approved, (school) => [
      tx<{ id: string }[]>`
        SELECT ${school.id}::uuid AS id
        WHERE NOT EXISTS (
          SELECT 1 FROM app.erpnext_site_configs
          WHERE school_id = current_setting('app.school_id')::uuid
        )
      `,
    ]);
    const missingIds = new Set(perSchool.flatMap(([rows]) => rows.map((row) => row.id)));
    return { approved, missing: approved.filter((school) => missingIds.has(school.id)) };
  });
}

export async function backfillErpNextSites(
  database: Database,
  options: { apply: boolean; logger: Logger },
): Promise<BackfillResult> {
  const { approved, missing } = await findMissing(database);
  let written = 0;
  if (options.apply) {
    for (const school of missing) {
      const inserted = await registerErpNextSite(
        database,
        {
          schoolId: school.id,
          slug: school.slug,
          schoolName: school.name,
          tenantContext: { schoolId: school.id },
        },
        options.logger,
      );
      if (inserted) written += 1;
    }
  }
  return {
    approved: approved.length,
    alreadyRegistered: approved.length - missing.length,
    missing,
    written,
  };
}

if (import.meta.main) {
  const apply = process.argv.includes("--apply");
  const env = loadEnv();
  const database = createDatabase(env);
  if (!database) {
    console.error("DATABASE_HOST is not set");
    process.exit(1);
  }
  try {
    const result = await backfillErpNextSites(database, { apply, logger: createLogger() });
    for (const school of result.missing) {
      console.log(
        `${apply ? "wrote" : "would write"} ${erpNextSiteName(school.slug)}  (${school.id})`,
      );
    }
    console.log(
      JSON.stringify({
        mode: apply ? "apply" : "dry-run",
        approved_schools: result.approved,
        already_registered: result.alreadyRegistered,
        missing: result.missing.length,
        written: result.written,
      }),
    );
    if (!apply && result.missing.length > 0) console.log("dry run: re-run with --apply to write");
  } finally {
    await database.end({ timeout: 5 });
  }
}
