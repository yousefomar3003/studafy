import { DOMAIN_EVENTS } from "@studafy/constants";

import { ErpNextError } from "../../../erpnext/client";
import { emit } from "../../../lib/events/emitter";
import { getCurrencyByCode, toMinorUnits } from "../currency";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { TenantErpNextFactory } from "../client/tenant-client";
import type { TransactionSql } from "postgres";

const FEE_SCHEDULE_RESOURCE = "/api/resource/Fee%20Schedule";

export interface ReconciliationResult {
  schoolId: string;
  recordsChecked: number;
  driftDetectedCount: number;
  autoHealedCount: number;
  unresolvedDivergences: UnresolvedDivergence[];
  status: "success" | "drift_corrected" | "alerted_divergence";
}

export interface UnresolvedDivergence {
  schoolId: string;
  studentId: string;
  erpnextFeeScheduleId: string;
  erpnextOutstanding: number;
  localOutstanding: number;
}

export interface GlobalReconciliationResult {
  schoolsProcessed: number;
  totalDriftDetected: number;
  totalAutoHealed: number;
  totalUnresolved: number;
  jobRunAt: string;
}

// ---------------------------------------------------------------------------
// Fee Schedule DocType shape (subset)
// ---------------------------------------------------------------------------

interface FeeScheduleDoc {
  name?: string;
  student?: string | null;
  fee_structure?: string | null;
  total_amount?: number | string | null;
  paid_amount?: number | string | null;
  outstanding_amount?: number | string | null;
  currency?: string | null;
  due_date?: string | null;
  docstatus?: number | null;
}

// ---------------------------------------------------------------------------
// Phase 1: Overdue flagging
// ---------------------------------------------------------------------------

interface OverdueItem {
  id: string;
  student_id: string;
  erpnext_fee_schedule_id: string;
  due_date: Date;
  outstanding_amount_minor: number;
}

async function flagOverdueInstallments(
  tx: TransactionSql,
  schoolId: string,
  logger?: Logger,
): Promise<OverdueItem[]> {
  const overdue = await tx<OverdueItem[]>`
    UPDATE app.fee_schedule_cache
    SET status = 'overdue',
        updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid
      AND due_date < CURRENT_DATE
      AND status IN ('pending', 'partially_paid')
    RETURNING id, student_id, erpnext_fee_schedule_id, due_date, outstanding_amount_minor
  `;

  for (const item of overdue) {
    try {
      await emit(tx, DOMAIN_EVENTS.FEE_INSTALLMENT_OVERDUE, {
        studentId: item.student_id,
        scheduleId: item.id,
        dueDate: item.due_date.toISOString().slice(0, 10),
        outstandingAmountMinor: item.outstanding_amount_minor,
      });
    } catch (err) {
      logger?.error?.(
        { schoolId, scheduleId: item.id, err },
        "failed to emit overdue event for installment",
      );
    }
  }

  return overdue;
}

// ---------------------------------------------------------------------------
// Phase 2 & 3: Drift detection and self-healing
// ---------------------------------------------------------------------------

interface CacheRowForReconciliation {
  id: string;
  student_id: string;
  erpnext_fee_schedule_id: string;
  due_date: Date;
  total_amount_minor: number;
  paid_amount_minor: number;
  outstanding_amount_minor: number;
  currency_id: string;
  status: string;
}

async function detectAndHealDrift(
  tx: TransactionSql,
  schoolId: string,
  erpnext: {
    get: <T>(path: string, options?: { acceptLanguage?: string }) => Promise<{ data: { data: T } }>;
  },
  logger?: Logger,
): Promise<{
  recordsChecked: number;
  driftDetectedCount: number;
  autoHealedCount: number;
  unresolved: UnresolvedDivergence[];
}> {
  const records = await tx<CacheRowForReconciliation[]>`
    SELECT id, student_id, erpnext_fee_schedule_id, due_date,
           total_amount_minor, paid_amount_minor, outstanding_amount_minor,
           currency_id, status
    FROM app.fee_schedule_cache
    WHERE school_id = ${schoolId}::uuid
      AND status IN ('pending', 'partially_paid', 'overdue')
  `;

  let driftDetected = 0;
  let autoHealed = 0;
  const unresolved: UnresolvedDivergence[] = [];

  for (const row of records) {
    let remote: FeeScheduleDoc;
    try {
      const response = await erpnext.get<FeeScheduleDoc>(
        `${FEE_SCHEDULE_RESOURCE}/${encodeURIComponent(row.erpnext_fee_schedule_id)}`,
      );
      remote = response.data.data;
    } catch (err) {
      if (err instanceof ErpNextError && err.status === 404) {
        logger?.warn?.(
          { schoolId, erpnextFeeScheduleId: row.erpnext_fee_schedule_id },
          "fee schedule not found in ERPNext during reconciliation",
        );
      } else {
        logger?.error?.(
          { schoolId, erpnextFeeScheduleId: row.erpnext_fee_schedule_id, err },
          "failed to query ERPNext for fee schedule during reconciliation",
        );
      }
      continue;
    }

    const remoteOutstanding =
      remote.outstanding_amount != null
        ? toMinorUnits(Number(remote.outstanding_amount), 3)
        : BigInt(row.outstanding_amount_minor);

    const localOutstanding = BigInt(row.outstanding_amount_minor);

    if (remoteOutstanding === localOutstanding) {
      continue;
    }

    driftDetected++;

    const totalAmount = Number(remote.total_amount ?? 0);
    const paidAmount = Number(remote.paid_amount ?? 0);
    const outstandingAmount = Number(remote.outstanding_amount ?? totalAmount);
    const currencyCode = (remote.currency ?? "JOD").toUpperCase();

    const currency = await getCurrencyByCode(tx, currencyCode);
    if (!currency) {
      unresolved.push({
        schoolId,
        studentId: row.student_id,
        erpnextFeeScheduleId: row.erpnext_fee_schedule_id,
        erpnextOutstanding: Number(remoteOutstanding),
        localOutstanding: Number(localOutstanding),
      });
      continue;
    }

    const totalMinor = toMinorUnits(totalAmount, currency.minorUnit);
    const paidMinor = toMinorUnits(paidAmount, currency.minorUnit);
    const outstandingMinor = toMinorUnits(outstandingAmount, currency.minorUnit);

    let newStatus: string;
    if (outstandingMinor <= 0n) {
      newStatus = "paid";
    } else if (paidMinor > 0n) {
      newStatus = "partially_paid";
    } else {
      newStatus = "pending";
    }

    if (row.due_date < new Date() && newStatus !== "paid") {
      newStatus = "overdue";
    }

    await tx`
      UPDATE app.fee_schedule_cache
      SET total_amount_minor      = ${totalMinor.toString()}::bigint,
          paid_amount_minor       = ${paidMinor.toString()}::bigint,
          outstanding_amount_minor = ${outstandingMinor.toString()}::bigint,
          currency_id             = ${currency.id}::uuid,
          status                  = ${newStatus},
          synced_at               = CURRENT_TIMESTAMP,
          updated_at              = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}::uuid
        AND erpnext_fee_schedule_id = ${row.erpnext_fee_schedule_id}
    `;

    const recheck = await tx<{ outstanding_amount_minor: number }[]>`
      SELECT outstanding_amount_minor
      FROM app.fee_schedule_cache
      WHERE school_id = ${schoolId}::uuid
        AND erpnext_fee_schedule_id = ${row.erpnext_fee_schedule_id}
    `;

    const recheckedOutstanding = BigInt(recheck[0]?.outstanding_amount_minor ?? 0);
    if (recheckedOutstanding !== remoteOutstanding) {
      unresolved.push({
        schoolId,
        studentId: row.student_id,
        erpnextFeeScheduleId: row.erpnext_fee_schedule_id,
        erpnextOutstanding: Number(remoteOutstanding),
        localOutstanding: Number(recheckedOutstanding),
      });
    } else {
      autoHealed++;
    }
  }

  return {
    recordsChecked: records.length,
    driftDetectedCount: driftDetected,
    autoHealedCount: autoHealed,
    unresolved,
  };
}

// ---------------------------------------------------------------------------
// Phase 4: Audit logging
// ---------------------------------------------------------------------------

async function logReconciliationRun(
  tx: TransactionSql,
  schoolId: string,
  result: ReconciliationResult,
): Promise<void> {
  await tx`
    INSERT INTO app.finance_reconciliation_logs (
      school_id, job_run_at, records_checked, drift_detected_count,
      auto_healed_count, unresolved_divergences, status
    ) VALUES (
      ${schoolId}::uuid,
      CURRENT_TIMESTAMP,
      ${result.recordsChecked},
      ${result.driftDetectedCount},
      ${result.autoHealedCount},
      ${tx.json(JSON.stringify(result.unresolvedDivergences))}::jsonb,
      ${result.status}
    )
  `;
}

// ---------------------------------------------------------------------------
// Main reconciliation — runs per school
// ---------------------------------------------------------------------------

export async function reconcileSchool(
  tx: TransactionSql,
  schoolId: string,
  erpnext: {
    get: <T>(path: string, options?: { acceptLanguage?: string }) => Promise<{ data: { data: T } }>;
  },
  logger?: Logger,
): Promise<ReconciliationResult> {
  await flagOverdueInstallments(tx, schoolId, logger);

  const { recordsChecked, driftDetectedCount, autoHealedCount, unresolved } =
    await detectAndHealDrift(tx, schoolId, erpnext, logger);

  let status: ReconciliationResult["status"] = "success";
  if (unresolved.length > 0) {
    status = "alerted_divergence";
  } else if (driftDetectedCount > 0) {
    status = "drift_corrected";
  }

  const result: ReconciliationResult = {
    schoolId,
    recordsChecked,
    driftDetectedCount,
    autoHealedCount,
    unresolvedDivergences: unresolved,
    status,
  };

  await logReconciliationRun(tx, schoolId, result);

  if (unresolved.length > 0) {
    try {
      await emit(tx, DOMAIN_EVENTS.FINANCE_RECONCILIATION_DIVERGENCE, {
        schoolId,
        studentId: unresolved[0]!.studentId,
        erpnextFeeScheduleId: unresolved[0]!.erpnextFeeScheduleId,
        erpnextOutstanding: unresolved[0]!.erpnextOutstanding,
        localOutstanding: unresolved[0]!.localOutstanding,
      });
    } catch (err) {
      logger?.error?.({ schoolId, err }, "failed to emit reconciliation divergence event");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Global reconciliation — across all schools
// ---------------------------------------------------------------------------

export async function runGlobalReconciliation(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
  logger?: Logger,
): Promise<GlobalReconciliationResult> {
  const schools = await database<{ id: string }[]>`SELECT id FROM app.schools`;

  let totalDrift = 0;
  let totalHealed = 0;
  let totalUnresolved = 0;

  for (const school of schools) {
    try {
      const result = await database.begin(async (tx) => {
        await tx`SELECT set_config('role', 'studafy_app', true)`.execute();
        await tx`SELECT set_config('app.school_id', ${school.id}, true)`.execute();

        const erpnext = await erpnextFactory.forSchool(tx, school.id);

        return reconcileSchool(tx, school.id, erpnext, logger);
      });

      totalDrift += result.driftDetectedCount;
      totalHealed += result.autoHealedCount;
      totalUnresolved += result.unresolvedDivergences.length;

      logger?.info?.(
        {
          schoolId: school.id,
          status: result.status,
          recordsChecked: result.recordsChecked,
          driftDetected: result.driftDetectedCount,
          autoHealed: result.autoHealedCount,
          unresolved: result.unresolvedDivergences.length,
        },
        "school reconciliation complete",
      );
    } catch (err) {
      logger?.error?.({ schoolId: school.id, err }, "school reconciliation failed");
    }
  }

  return {
    schoolsProcessed: schools.length,
    totalDriftDetected: totalDrift,
    totalAutoHealed: totalHealed,
    totalUnresolved,
    jobRunAt: new Date().toISOString(),
  };
}
