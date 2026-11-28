/**
 * The ERPNext site agent's view of app.erpnext_site_configs (docs/plans/erpnext-fly.md, "Agent API").
 *
 * The agent runs on the ERPNext machine and has no tenant: it creates, wakes and sleeps every
 * school's site. These reads and writes are therefore cross-school, and they are done the way the
 * platform console does them (modules/platform/service.ts, "How a cross-tenant read works here"):
 * the table keeps its FORCE'd tenant_isolation policy, nothing reads it across schools in one
 * statement, and a `withSystemTx` arms each school's scope in turn through `pipelinePerSchool`, one
 * round trip for all of them. A write by row id first finds the school that owns the row the same
 * way, then arms that school alone, so the update and its audit row land in that school.
 *
 * A school has at most one row (uq_erpnext_site_configs_school), so "every school's matching row"
 * is small, and the oldest-first ordering and the pending limit are applied after the reads.
 */

import { pipelinePerSchool, setTenantScope, withSystemTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { Database, DatabasePools } from "../../../db/client";
import type { TransactionSql } from "postgres";

/** At most this many sites per pending poll: the agent creates them one at a time. */
export const PENDING_SITES_LIMIT = 5;
/** A failed site is offered again this long after its failure. */
export const FAILED_RETRY_MINUTES = 10;
/** An awake site with no finance activity for this long is put back to sleep. */
export const IDLE_DAYS = 30;

/** What bench needs to create a site. No personal data. */
export interface PendingSite {
  id: string;
  school_id: string;
  site_name: string;
  company_name: string;
  company_abbr: string;
  /** ISO 4217, from the school's default currency. */
  currency_code: string;
  /** ISO 3166-1 alpha-2, uppercase, from the school's country. */
  country_code: string;
}

export interface SiteRef {
  id: string;
  site_name: string;
}

export type SiteTransition = "created" | "failed" | "woken" | "slept";

const DEFAULT_CURRENCY_CODE = "JOD";
const DEFAULT_COUNTRY_CODE = "JO";

type AgentDatabase = Database | DatabasePools;

/** Every school. app.schools is a global table. */
function listSchools(tx: TransactionSql): Promise<{ id: string }[]> {
  return tx<{ id: string }[]>`SELECT id FROM app.schools ORDER BY id`;
}

interface PendingRow {
  id: string;
  school_id: string;
  site_name: string;
  company_name: string;
  company_abbr: string;
  currency_code: string | null;
  country_code: string | null;
  created_at: Date;
}

/**
 * Sites the agent should create: not created yet, and either waiting or failed at least
 * FAILED_RETRY_MINUTES ago. A row the resolver has marked 'completed' is never offered, and neither
 * is a row whose site exists (`site_created_at`), so bench never runs `new-site` over a live site.
 */
export async function listPendingSites(database: AgentDatabase): Promise<PendingSite[]> {
  return withSystemTx(database, async (tx) => {
    const schools = await listSchools(tx);
    const perSchool = await pipelinePerSchool(tx, schools, () => [
      // The codes come from the school: its default currency and its country (global tables).
      tx<PendingRow[]>`
        SELECT c.id, c.school_id, c.site_name, c.company_name, c.company_abbr, c.created_at,
               cu.code AS currency_code, co.alpha2_code AS country_code
        FROM app.erpnext_site_configs c
        JOIN app.schools s ON s.id = c.school_id
        LEFT JOIN app.currencies cu ON cu.id = s.default_currency_id
        LEFT JOIN app.countries co ON co.id = s.country_id
        WHERE c.school_id = current_setting('app.school_id')::uuid
          AND c.site_created_at IS NULL
          AND (
            c.status = 'pending'::app.provisioning_status
            OR (
              c.status = 'failed'::app.provisioning_status
              AND c.updated_at < now() - make_interval(mins => ${FAILED_RETRY_MINUTES})
            )
          )
      `,
    ]);

    return perSchool
      .flatMap(([rows]) => rows)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))
      .slice(0, PENDING_SITES_LIMIT)
      .map((row) => ({
        id: row.id,
        school_id: row.school_id,
        site_name: row.site_name,
        company_name: row.company_name,
        company_abbr: row.company_abbr,
        currency_code: (row.currency_code ?? DEFAULT_CURRENCY_CODE).toUpperCase(),
        country_code: (row.country_code ?? DEFAULT_COUNTRY_CODE).toUpperCase(),
      }));
  });
}

interface SiteRefRow {
  id: string;
  site_name: string;
  sort_at: Date | null;
}

/** Sleeping sites whose school asked for finance since they fell asleep. Oldest request first. */
export async function listWakeSites(database: AgentDatabase): Promise<SiteRef[]> {
  return withSystemTx(database, async (tx) => {
    const schools = await listSchools(tx);
    const perSchool = await pipelinePerSchool(tx, schools, () => [
      tx<SiteRefRow[]>`
        SELECT id, site_name, wake_requested_at AS sort_at
        FROM app.erpnext_site_configs
        WHERE school_id = current_setting('app.school_id')::uuid
          AND site_created_at IS NOT NULL
          AND scheduler_enabled = false
          AND wake_requested_at IS NOT NULL
      `,
    ]);
    return toSiteRefs(perSchool.flatMap(([rows]) => rows));
  });
}

/** Awake sites with no finance activity (or, never used, no use since creation) for IDLE_DAYS. */
export async function listIdleSites(database: AgentDatabase): Promise<SiteRef[]> {
  return withSystemTx(database, async (tx) => {
    const schools = await listSchools(tx);
    const perSchool = await pipelinePerSchool(tx, schools, () => [
      tx<SiteRefRow[]>`
        SELECT id, site_name, COALESCE(last_finance_activity_at, site_created_at) AS sort_at
        FROM app.erpnext_site_configs
        WHERE school_id = current_setting('app.school_id')::uuid
          AND scheduler_enabled = true
          AND COALESCE(last_finance_activity_at, site_created_at)
            < now() - make_interval(days => ${IDLE_DAYS})
      `,
    ]);
    return toSiteRefs(perSchool.flatMap(([rows]) => rows));
  });
}

function toSiteRefs(rows: SiteRefRow[]): SiteRef[] {
  return rows
    .sort((a, b) => (a.sort_at?.getTime() ?? 0) - (b.sort_at?.getTime() ?? 0))
    .map(({ id, site_name }) => ({ id, site_name }));
}

/** The school owning site config `id`, or null. Reads each school's scope in turn. */
async function findOwningSchool(tx: TransactionSql, id: string): Promise<string | null> {
  const schools = await listSchools(tx);
  const perSchool = await pipelinePerSchool(tx, schools, () => [
    tx<{ school_id: string }[]>`
      SELECT school_id
      FROM app.erpnext_site_configs
      WHERE school_id = current_setting('app.school_id')::uuid
        AND id = ${id}::uuid
    `,
  ]);
  return perSchool.flatMap(([rows]) => rows)[0]?.school_id ?? null;
}

interface SiteState {
  status: string;
  site_created_at: Date | null;
  scheduler_enabled: boolean;
  wake_requested_at: Date | null;
}

/** The audited view of a row: its state, never `last_error` (bench output stays on the row). */
function auditState(row: SiteState): Record<string, unknown> {
  return {
    status: row.status,
    site_created_at: row.site_created_at?.toISOString() ?? null,
    scheduler_enabled: row.scheduler_enabled,
    wake_requested_at: row.wake_requested_at?.toISOString() ?? null,
  };
}

function updateFor(
  tx: TransactionSql,
  id: string,
  transition: SiteTransition,
  error: string | undefined,
) {
  switch (transition) {
    case "created":
      // Back to 'pending' rather than 'completed': the credential resolver marks the site completed
      // (with its company) on the school's first finance request, once the site answers.
      return tx<SiteState[]>`
        UPDATE app.erpnext_site_configs
        SET site_created_at = now(),
            scheduler_enabled = false,
            last_error = NULL,
            status = 'pending'::app.provisioning_status,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}::uuid
        RETURNING status::text AS status, site_created_at, scheduler_enabled, wake_requested_at
      `;
    case "failed":
      return tx<SiteState[]>`
        UPDATE app.erpnext_site_configs
        SET status = 'failed'::app.provisioning_status,
            last_error = ${error ?? null},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}::uuid
        RETURNING status::text AS status, site_created_at, scheduler_enabled, wake_requested_at
      `;
    case "woken":
      return tx<SiteState[]>`
        UPDATE app.erpnext_site_configs
        SET scheduler_enabled = true,
            wake_requested_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}::uuid
        RETURNING status::text AS status, site_created_at, scheduler_enabled, wake_requested_at
      `;
    case "slept":
      return tx<SiteState[]>`
        UPDATE app.erpnext_site_configs
        SET scheduler_enabled = false,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}::uuid
        RETURNING status::text AS status, site_created_at, scheduler_enabled, wake_requested_at
      `;
  }
}

export interface TransitionOptions {
  /** Required for "failed": the agent's error, 1-2000 characters (validated by the route). */
  error?: string;
  requestId?: string;
  userAgent?: string;
}

/**
 * Apply one agent report to site config `id`, with an audit row in the owning school (NULL actor:
 * a machine did it, the convention webhook-driven rows use). Returns false for an unknown id.
 */
export async function applySiteTransition(
  database: AgentDatabase,
  id: string,
  transition: SiteTransition,
  options: TransitionOptions = {},
): Promise<boolean> {
  return withSystemTx(database, async (tx) => {
    const schoolId = await findOwningSchool(tx, id);
    if (!schoolId) return false;

    await setTenantScope(tx, schoolId, options.requestId);
    const [before] = await tx<SiteState[]>`
      SELECT status::text AS status, site_created_at, scheduler_enabled, wake_requested_at
      FROM app.erpnext_site_configs
      WHERE id = ${id}::uuid
      FOR UPDATE
    `;
    if (!before) return false;

    const [after] = await updateFor(tx, id, transition, options.error);
    if (!after) return false;

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "erpnext_site_configs",
      targetId: id,
      oldValues: auditState(before),
      newValues: { ...auditState(after), agent_report: transition },
      userAgent: options.userAgent,
    });
    return true;
  });
}
