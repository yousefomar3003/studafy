/**
 * The school license lifecycle job (session 3 of docs/billing/feature-licensing.md). Hourly, per
 * school:
 *
 *  1. licenses past their end date (active or suspended) become `expired`, and every seat holder's
 *     `user` entitlement version is bumped with a `userEntitlement.changed` event -- coverage already
 *     stops at `ends_at` in the resolver, so this records the status and refreshes caches;
 *  2. sent quotes past their valid-until date become `expired`;
 *  3. unpaid invoices past their due date are marked overdue (`overdue_at`); their status still says
 *     how much is paid. Each instalment not paid by its due date is marked overdue the same way
 *     (000221); an invoice's due date is its earliest unpaid instalment's;
 *  4. AI stops 30 days after an unpaid instalment (000233): an active licence with any unpaid
 *     instalment LICENSE_NONPAYMENT_GRACE_DAYS or more past its due date (UTC dates) is suspended and
 *     marked `nonpayment_suspended_at`, and its seat holders' entitlements are bumped so the AI stops
 *     at once. Every instalment counts: a later one going unpaid stops it again;
 *  5. a licence stopped for non-payment with nothing past the cutoff any more (paid, or its invoice
 *     voided) is resumed. The API resumes it the moment the payment is recorded; this is the safety
 *     net. A licence the super admin suspended by hand is never resumed here.
 *
 * Each school runs in its own system tenant transaction (one failing school does not strand the
 * rest), every change writes an audit row with no actor, and every step is idempotent: a re-run finds
 * nothing left to change.
 */

import { LICENSE_NONPAYMENT_GRACE_DAYS } from "@studafy/constants";

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
  licensesStopped: number;
  licensesResumed: number;
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

/** Mark unpaid invoices, and their unpaid instalments, past their due date (UTC) overdue, once. */
export async function markInvoicesOverdue(tx: TransactionSql, now: Date): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const instalments = await tx<{ id: string; invoice_id: string; due_date: string }[]>`
    UPDATE app.license_invoice_instalments AS inst
    SET overdue_at = ${now}, updated_at = GREATEST(CURRENT_TIMESTAMP, inst.updated_at)
    FROM app.license_invoices AS i
    WHERE inst.school_id = current_setting('app.school_id')::uuid
      AND i.school_id = inst.school_id AND i.id = inst.invoice_id
      AND i.status IN ('issued', 'partially_paid')
      AND inst.status <> 'paid'
      AND inst.due_date < ${today}::date
      AND inst.overdue_at IS NULL
    RETURNING inst.id::text AS id, inst.invoice_id::text AS invoice_id,
              inst.due_date::text AS due_date
  `;
  await emitAuditLogs(
    tx,
    instalments.map((instalment) => ({
      action: "update" as const,
      targetTable: "license_invoice_instalments",
      targetId: instalment.id,
      oldValues: { overdue_at: null },
      newValues: {
        overdue_at: now.toISOString(),
        due_date: instalment.due_date,
        invoice_id: instalment.invoice_id,
      },
    })),
  );

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

/** Bump the entitlements of a licence's current seat holders. */
async function bumpSeatHolders(
  tx: TransactionSql,
  schoolId: string,
  licenseIds: string[],
): Promise<number> {
  if (licenseIds.length === 0) return 0;
  const holders = await tx<{ user_id: string }[]>`
    SELECT DISTINCT user_id::text AS user_id
    FROM app.license_seats
    WHERE school_id = current_setting('app.school_id')::uuid
      AND license_id = ANY(${licenseIds}::uuid[])
      AND unassigned_at IS NULL
  `;
  const versions = await publishUserEntitlementChanges(
    tx,
    schoolId,
    holders.map((h) => h.user_id),
  );
  return versions.size;
}

/**
 * Suspend every active licence with an unpaid instalment LICENSE_NONPAYMENT_GRACE_DAYS or more past
 * its due date (`today` >= due date + 30, both UTC dates). Idempotent: a suspended licence is not
 * picked again.
 */
export async function stopForNonPayment(
  tx: TransactionSql,
  schoolId: string,
  now: Date,
): Promise<{ stopped: number; bumped: number }> {
  const today = now.toISOString().slice(0, 10);
  const stopped = await tx<{ id: string; due_date: string; instalment_id: string }[]>`
    UPDATE app.school_licenses AS l
    SET status = 'suspended', nonpayment_suspended_at = ${now},
        updated_at = GREATEST(CURRENT_TIMESTAMP, l.updated_at)
    FROM (
      SELECT DISTINCT ON (i.license_id) i.license_id, inst.id AS instalment_id, inst.due_date
      FROM app.license_invoice_instalments AS inst
      JOIN app.license_invoices AS i ON i.id = inst.invoice_id AND i.school_id = inst.school_id
      WHERE inst.school_id = current_setting('app.school_id')::uuid
        AND i.status IN ('issued', 'partially_paid')
        AND inst.status <> 'paid'
        AND inst.due_date + ${LICENSE_NONPAYMENT_GRACE_DAYS}::int <= ${today}::date
      ORDER BY i.license_id, inst.due_date, inst.position
    ) AS late
    WHERE l.school_id = current_setting('app.school_id')::uuid
      AND l.id = late.license_id
      AND l.status = 'active'
    RETURNING l.id::text AS id, late.due_date::text AS due_date,
              late.instalment_id::text AS instalment_id
  `;
  if (stopped.length === 0) return { stopped: 0, bumped: 0 };
  await emitAuditLogs(
    tx,
    stopped.map((license) => ({
      action: "update" as const,
      targetTable: "school_licenses",
      targetId: license.id,
      oldValues: { status: "active" },
      newValues: {
        status: "suspended",
        reason: "non_payment",
        nonpayment_suspended_at: now.toISOString(),
        instalment_id: license.instalment_id,
        instalment_due_date: license.due_date,
      },
    })),
  );
  const bumped = await bumpSeatHolders(
    tx,
    schoolId,
    stopped.map((l) => l.id),
  );
  return { stopped: stopped.length, bumped };
}

/**
 * Resume every licence stopped for non-payment that has nothing past the cutoff any more and has not
 * ended, unless the school has another licence active by now. Idempotent.
 */
export async function resumePaidLicenses(
  tx: TransactionSql,
  schoolId: string,
  now: Date,
): Promise<{ resumed: number; bumped: number }> {
  const today = now.toISOString().slice(0, 10);
  // One at a time: a school has at most one active licence.
  const resumed = await tx<{ id: string }[]>`
    UPDATE app.school_licenses AS l
    SET status = 'active', updated_at = GREATEST(CURRENT_TIMESTAMP, l.updated_at)
    WHERE l.school_id = current_setting('app.school_id')::uuid
      AND l.id = (
        SELECT c.id FROM app.school_licenses AS c
        WHERE c.school_id = current_setting('app.school_id')::uuid
          AND c.status = 'suspended'
          AND c.nonpayment_suspended_at IS NOT NULL
          AND c.ends_at > ${now}
          AND NOT EXISTS (
            SELECT 1 FROM app.school_licenses AS other
            WHERE other.school_id = c.school_id AND other.status = 'active'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM app.license_invoice_instalments AS inst
            JOIN app.license_invoices AS i
              ON i.id = inst.invoice_id AND i.school_id = inst.school_id
            WHERE inst.school_id = c.school_id
              AND i.license_id = c.id
              AND i.status IN ('issued', 'partially_paid')
              AND inst.status <> 'paid'
              AND inst.due_date + ${LICENSE_NONPAYMENT_GRACE_DAYS}::int <= ${today}::date
          )
        ORDER BY c.starts_at DESC, c.id
        LIMIT 1
      )
    RETURNING l.id::text AS id
  `;
  if (resumed.length === 0) return { resumed: 0, bumped: 0 };
  await emitAuditLogs(
    tx,
    resumed.map((license) => ({
      action: "update" as const,
      targetTable: "school_licenses",
      targetId: license.id,
      oldValues: { status: "suspended", reason: "non_payment" },
      newValues: { status: "active", nonpayment_suspended_at: null },
    })),
  );
  const bumped = await bumpSeatHolders(
    tx,
    schoolId,
    resumed.map((l) => l.id),
  );
  return { resumed: resumed.length, bumped };
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
    licensesStopped: 0,
    licensesResumed: 0,
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
        const stopped = await stopForNonPayment(tx, schoolId, now);
        result.licensesStopped += stopped.stopped;
        const resumed = await resumePaidLicenses(tx, schoolId, now);
        result.licensesResumed += resumed.resumed;
        result.entitlementBumps += stopped.bumped + resumed.bumped;
      });
    } catch (err) {
      result.failedSchools += 1;
      log.warn({ err, school_id: schoolId }, "license lifecycle failed for school");
    }
  }

  log.info({ ...result }, "license lifecycle complete");
  return result;
}
