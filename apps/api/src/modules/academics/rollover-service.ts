import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { withTenantTx } from "../../db/tenant-tx";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { AcademicPeriodStatus } from "./academic-year-service";
import type { Database } from "../../db/client";
import type { TenantContext } from "../../db/tenant-tx";
import type { TransactionSql } from "postgres";


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RolloverResult {
  prior_year_id: string | null;
  prior_year_status: AcademicPeriodStatus | null;
  new_year_id: string;
  new_year_status: "active";
  enrollments_archived: number;
}

interface YearRow {
  id: string;
  status: AcademicPeriodStatus;
  starts_on: Date;
  ends_on: Date;
}

// ---------------------------------------------------------------------------
// Rollover
// ---------------------------------------------------------------------------

/**
 * Roll the academic year: transition the target year to active, archive the prior
 * active year, and close all enrollments in classes belonging to the prior year.
 *
 * Executes as a single atomic transaction via withTenantTx.
 */
export async function rolloverAcademicYear(
  database: Database,
  tenant: TenantContext,
  targetYearId: string,
): Promise<RolloverResult> {
  return withTenantTx(database, tenant, (tx) => executeRollover(tx, tenant.schoolId, targetYearId));
}

async function executeRollover(
  tx: TransactionSql,
  schoolId: string,
  targetYearId: string,
): Promise<RolloverResult> {
  // 1. Load the target year
  const [targetYear] = await tx<YearRow[]>`
    SELECT id, status, starts_on, ends_on
    FROM app.academic_years
    WHERE id = ${targetYearId} AND school_id = ${schoolId}
  `;

  if (!targetYear) {
    throw new HTTPException(404, { message: "Academic year not found" });
  }

  if (targetYear.status === "active") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "The target academic year is already active.",
    );
  }

  // 2. Find the current active year (if any)
  const [activeYear] = await tx<YearRow[]>`
    SELECT id, status, starts_on, ends_on
    FROM app.academic_years
    WHERE school_id = ${schoolId} AND status = 'active'
  `;

  // 3. Validate no date overlap between target and any existing active year
  if (activeYear) {
    const overlaps = await tx<{ id: string }[]>`
      SELECT id
      FROM app.academic_years
      WHERE school_id = ${schoolId}
        AND id = ${targetYearId}
        AND starts_on < ${activeYear.ends_on}
        AND ends_on > ${activeYear.starts_on}
    `;

    if (overlaps.length > 0) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.ACADEMIC_YEAR_DATE_OVERLAP,
        "The target academic year overlaps with the currently active year.",
      );
    }
  }

  // 4. Archive enrollments from classes belonging to the prior active year
  let enrollmentsArchived = 0;

  if (activeYear) {
    const archived = await tx`
      UPDATE app.enrollments
      SET status = 'completed'::app.enrollment_status,
          updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}
        AND status = 'active'
        AND class_id IN (
          SELECT id FROM app.classes
          WHERE academic_year_id = ${activeYear.id} AND school_id = ${schoolId}
        )
      RETURNING class_id
    `;
    enrollmentsArchived = archived.length;

    // 5. Transition the prior active year to closed
    await tx`
      UPDATE app.academic_years
      SET status = 'closed'::app.academic_period_status,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${activeYear.id} AND school_id = ${schoolId}
    `;
  }

  // 6. Activate the target year
  const [activated] = await tx<YearRow[]>`
    UPDATE app.academic_years
    SET status = 'active'::app.academic_period_status,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${targetYearId} AND school_id = ${schoolId}
    RETURNING id, status, starts_on, ends_on
  `;

  if (!activated) {
    throw new HTTPException(500, { message: "Failed to activate target academic year" });
  }

  // 7. Emit audit logs
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "academic_years",
    targetId: targetYearId,
    oldValues: activeYear
      ? { prior_year_id: activeYear.id, prior_status: activeYear.status }
      : null,
    newValues: {
      activated_year_id: targetYearId,
      prior_year_id: activeYear?.id ?? null,
      prior_year_closed: activeYear ? true : false,
      enrollments_archived: enrollmentsArchived,
    },
  });

  if (enrollmentsArchived > 0) {
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "enrollments",
      targetId: targetYearId,
      newValues: {
        reason: "academic_year_rollover",
        archived_count: enrollmentsArchived,
        source_academic_year_id: activeYear?.id ?? null,
        target_academic_year_id: targetYearId,
      },
    });
  }

  return {
    prior_year_id: activeYear?.id ?? null,
    prior_year_status: activeYear ? "closed" : null,
    new_year_id: targetYearId,
    new_year_status: "active",
    enrollments_archived: enrollmentsArchived,
  };
}
