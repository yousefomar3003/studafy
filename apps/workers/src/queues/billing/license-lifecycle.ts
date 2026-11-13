/**
 * The school license lifecycle job (session 3 of docs/billing/feature-licensing.md). Hourly, per
 * school:
 *
 *  1. licenses past their end date (active or suspended) become `expired`, and every seat holder's
 *     `user` entitlement version is bumped with a `userEntitlement.changed` event -- coverage already
 *     stops at `ends_at` in the resolver, so this records the status and refreshes caches;
 *  2. sent quotes past their valid-until date become `expired`;
 *  3. unpaid invoices past their due date are marked overdue (`overdue_at`); their status still says
 *     how much is paid.
 *
 * Nothing here suspends a license: that is the super admin's decision, never automatic.
 *
 * Each school runs in its own system tenant transaction (one failing school does not strand the
 * rest), every change writes an audit row with no actor, and every step is idempotent: a re-run finds
 * nothing left to change.
 */

import { emitAuditLogs } from "../../db/audit";
import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import { publishUserEntitlementChanges } from "./entitlement-change-publisher";

import type { BillingLogger } from "@studafy/billing";
import type { Sql, TransactionSql } from "postgres";

export interface LicenseLifecycleResult {
  schools: number;
  licensesExpired: number;
  entitlementBumps: number;
  quotesExpired: number;
  invoicesOverdue: number;
  failedSchools: number;
}

/** Expire the school's licenses that have ended; bump their seat holders. */
export async function expireLicenses(
  tx: TransactionSql,
  schoolId: string,
  now: Date,
): Promise<{ expired: number; bumped: number }> {
  const expired = await tx<{ id: string; status: string }[]>`
    UPDATE app.school_licenses AS l
    SET status = 'expired', updated_at = GREATEST(CURRENT_TIMESTAMP, l.updated_at)
    FROM (
      SELECT id, status FROM app.school_licenses
      WHERE school_id = current_setting('app.school_id')::uuid
        AND status IN ('active', 'suspended')
        AND ends_at <= ${now}
      FOR UPDATE
    ) AS before
    WHERE l.id = before.id AND l.school_id = current_setting('app.school_id')::uuid
    RETURNING l.id::text AS id, before.status
  `;
  if (expired.length === 0) return { expired: 0, bumped: 0 };

  await emitAuditLogs(
    tx,
    expired.map((license) => ({
      action: "update" as const,
      targetTable: "school_licenses",
      targetId: license.id,
      oldValues: { status: license.status },
      newValues: { status: "expired" },
    })),
  );

  const holders = await tx<{ user_id: string }[]>`
    SELECT DISTINCT user_id::text AS user_id
    FROM app.license_seats
    WHERE school_id = current_setting('app.school_id')::uuid
      AND license_id = ANY(${expired.map((l) => l.id)}::uuid[])
      AND unassigned_at IS NULL
  `;
  const versions = await publishUserEntitlementChanges(
    tx,
    schoolId,
    holders.map((h) => h.user_id),
  );
  return { expired: expired.length, bumped: versions.size };
}

/** Expire sent quotes past their valid-until date. */
export async function expireQuotes(tx: TransactionSql, now: Date): Promise<number> {
  const expired = await tx<{ id: string }[]>`
    UPDATE app.license_quotes
    SET status = 'expired', closed_at = CURRENT_TIMESTAMP,
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid
      AND status = 'sent'
      AND valid_until < ${now}
    RETURNING id::text AS id
  `;
  await emitAuditLogs(
    tx,
    expired.map((quote) => ({
      action: "update" as const,
      targetTable: "license_quotes",
      targetId: quote.id,
      oldValues: { status: "sent" },
      newValues: { status: "expired" },
    })),
  );
  return expired.length;
}

/** Mark unpaid invoices past their due date (UTC) overdue, once. */
export async function markInvoicesOverdue(tx: TransactionSql, now: Date): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const marked = await tx<{ id: string; due_date: string }[]>`
    UPDATE app.license_invoices
    SET overdue_at = ${now}, updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid
      AND status IN ('issued', 'partially_paid')
      AND due_date < ${today}::date
      AND overdue_at IS NULL
    RETURNING id::text AS id, due_date::text AS due_date
  `;
  await emitAuditLogs(
    tx,
    marked.map((invoice) => ({
      action: "update" as const,
      targetTable: "license_invoices",
      targetId: invoice.id,
      oldValues: { overdue_at: null },
      newValues: { overdue_at: now.toISOString(), due_date: invoice.due_date },
    })),
  );
  return marked.length;
}

export async function runLicenseLifecycle(
  sql: Sql,
  now: Date,
  log: BillingLogger,
  schoolIds?: readonly string[],
): Promise<LicenseLifecycleResult> {
  const schools = schoolIds ?? (await loadSchoolIds(sql));
  const result: LicenseLifecycleResult = {
    schools: schools.length,
    licensesExpired: 0,
    entitlementBumps: 0,
    quotesExpired: 0,
    invoicesOverdue: 0,
    failedSchools: 0,
  };

  for (const schoolId of schools) {
    try {
      await withSystemTenantTx(sql, { schoolId }, async (tx) => {
        const licenses = await expireLicenses(tx, schoolId, now);
        result.licensesExpired += licenses.expired;
        result.entitlementBumps += licenses.bumped;
        result.quotesExpired += await expireQuotes(tx, now);
        result.invoicesOverdue += await markInvoicesOverdue(tx, now);
      });
    } catch (err) {
      result.failedSchools += 1;
      log.warn({ err, school_id: schoolId }, "license lifecycle failed for school");
    }
  }

  log.info({ ...result }, "license lifecycle complete");
  return result;
}
