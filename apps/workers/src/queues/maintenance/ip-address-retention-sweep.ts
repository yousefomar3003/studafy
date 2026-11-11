/**
 * IP address retention sweep.
 *
 * Studafy records the caller's IP address on session rows (app.refresh_tokens.ip_address) and on
 * boundary rejections (app.security_events.client_ip), and nothing ever removed them. The policy
 * (docs/modules/account-deletion.md "IP addresses") is that an address is kept for 90 days and then
 * removed: once a day this sets every such column older than that to NULL. The rows themselves stay
 * -- a session or a blocked probe is still worth knowing about; where it came from, after 90 days,
 * is not.
 *
 * - app.refresh_tokens is a tenant table (FORCE RLS), so it is swept per school under
 *   withSystemTenantTx. Its restrictive owner policy applies to studafy_app only, so the system
 *   role sees every user's sessions in the school; tenant isolation still binds.
 * - app.security_events is a global table with no tenant (000028) owned by studafy_admin; it is
 *   swept once under withSystemTx.
 * - app.audit_logs is NOT swept. It is append-only by grant and by trigger
 *   (docs/database/audit-log-partition-maintenance.md), and its addresses are kept for the audit
 *   log's lifetime -- the documented exception.
 *
 * Neither column is in a CHECK constraint, and neither table has an UPDATE trigger that cares about
 * it (refresh_tokens' only one fires on UPDATE OF school_id). One transaction per batch so a large
 * first-run backlog never holds row locks in one long transaction; SKIP LOCKED so a session being
 * rotated at that instant is left for tomorrow rather than waited on. A failure is logged, and the
 * sweep moves on to the next school (or table).
 */

import { withSystemTenantTx, withSystemTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import type { PurgeLogger } from "../imports";
import type { Sql, TransactionSql } from "postgres";

/** How long an IP address is kept before it is removed. */
export const IP_ADDRESS_RETENTION_DAYS = 90;

/** Rows updated per statement. */
export const IP_ADDRESS_RETENTION_BATCH_SIZE = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeExpiredIpAddressesResult {
  schools: number;
  /** Session (refresh-token) rows whose IP address was removed, across every school. */
  sessionIpsCleared: number;
  /** Security events whose IP address was removed. */
  securityEventIpsCleared: number;
  /** Schools, plus the global security-events pass, that aborted on a database error. */
  failed: number;
}

const silentLogger: PurgeLogger = { warn: () => undefined };

export async function purgeExpiredIpAddresses(
  sql: Sql,
  now: Date = new Date(),
  log: PurgeLogger = silentLogger,
): Promise<PurgeExpiredIpAddressesResult> {
  const cutoff = new Date(now.getTime() - IP_ADDRESS_RETENTION_DAYS * DAY_MS);
  const schoolIds = await loadSchoolIds(sql);
  const result: PurgeExpiredIpAddressesResult = {
    schools: schoolIds.length,
    sessionIpsCleared: 0,
    securityEventIpsCleared: 0,
    failed: 0,
  };

  for (const schoolId of schoolIds) {
    try {
      result.sessionIpsCleared += await drain(() =>
        withSystemTenantTx(sql, { schoolId }, (tx) => clearSessionIps(tx, schoolId, cutoff)),
      );
    } catch (error) {
      result.failed += 1;
      log.warn(
        { school_id: schoolId, error },
        "session IP address purge failed for school; batch rolled back and school skipped",
      );
    }
  }

  try {
    result.securityEventIpsCleared += await drain(() =>
      withSystemTx(sql, (tx) => clearSecurityEventIps(tx, cutoff)),
    );
  } catch (error) {
    result.failed += 1;
    log.warn({ error }, "security event IP address purge failed; batch rolled back");
  }

  return result;
}

/** Runs [batch] until it comes back short; returns the total rows it updated. */
async function drain(batch: () => Promise<number>): Promise<number> {
  let total = 0;
  let updated: number;
  do {
    updated = await batch();
    total += updated;
  } while (updated === IP_ADDRESS_RETENTION_BATCH_SIZE);
  return total;
}

async function clearSessionIps(
  tx: TransactionSql,
  schoolId: string,
  cutoff: Date,
): Promise<number> {
  // school_id is also enforced by tenant_isolation; naming it lets the planner use
  // idx_refresh_tokens_school_ip_created (000193).
  const rows = await tx`
    WITH batch AS (
      SELECT id
      FROM app.refresh_tokens
      WHERE school_id = ${schoolId}::uuid
        AND ip_address IS NOT NULL
        AND created_at < ${cutoff}
      LIMIT ${IP_ADDRESS_RETENTION_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE app.refresh_tokens AS rt
    SET ip_address = NULL
    FROM batch
    WHERE rt.id = batch.id
  `;
  return rows.count;
}

async function clearSecurityEventIps(tx: TransactionSql, cutoff: Date): Promise<number> {
  const rows = await tx`
    WITH batch AS (
      SELECT id
      FROM app.security_events
      WHERE client_ip IS NOT NULL
        AND created_at < ${cutoff}
      LIMIT ${IP_ADDRESS_RETENTION_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE app.security_events AS se
    SET client_ip = NULL
    FROM batch
    WHERE se.id = batch.id
  `;
  return rows.count;
}
