import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { Database } from "../../../db";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchoolSettingsRow {
  school_id: string;
  locale: string;
  timezone: string;
  grading_scheme: string;
  invitation_expiry_days: number;
  attendance_alert_threshold: number;
  absence_alert_threshold: number;
  created_at: Date;
  updated_at: Date;
}

export interface UpdateSchoolSettingsParams {
  locale?: string;
  timezone?: string;
  grading_scheme?: string;
  invitation_expiry_days?: number;
  attendance_alert_threshold?: number;
  absence_alert_threshold?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToSettings(row: SchoolSettingsRow): SchoolSettingsRow {
  return {
    school_id: row.school_id,
    locale: row.locale,
    timezone: row.timezone,
    grading_scheme: row.grading_scheme,
    invitation_expiry_days: row.invitation_expiry_days,
    attendance_alert_threshold: row.attendance_alert_threshold,
    absence_alert_threshold: row.absence_alert_threshold,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// GET /api/schools/current/settings
// ---------------------------------------------------------------------------

/**
 * Read the school's settings. Creates a default row if none exists (lazy init).
 */
export async function getSchoolSettings(
  database: Database,
  schoolId: string,
): Promise<SchoolSettingsRow> {
  const rows = await database<SchoolSettingsRow[]>`
    SELECT
      school_id::text,
      locale, timezone, grading_scheme,
      invitation_expiry_days,
      attendance_alert_threshold, absence_alert_threshold,
      created_at, updated_at
    FROM app.school_settings
    WHERE school_id = ${schoolId}::uuid
  `;

  if (rows.length > 0) return rowToSettings(rows[0]);

  // Lazy init: create the default settings row for this school.
  // Runs as studafy_app. The school already exists (caller is authenticated).
  const created = await database<SchoolSettingsRow[]>`
    INSERT INTO app.school_settings (school_id)
    VALUES (${schoolId}::uuid)
    RETURNING
      school_id::text,
      locale, timezone, grading_scheme,
      invitation_expiry_days,
      attendance_alert_threshold, absence_alert_threshold,
      created_at, updated_at
  `;

  if (created.length === 0) {
    throw new HTTPException(500, { message: "Failed to initialize school settings." });
  }

  return rowToSettings(created[0]);
}

// ---------------------------------------------------------------------------
// PATCH /api/schools/current/settings
// ---------------------------------------------------------------------------

/**
 * Partially update the school's settings. Every change is recorded as an audit entry
 * with the full before/after snapshot. Runs atomically.
 */
export async function updateSchoolSettings(
  database: Database,
  schoolId: string,
  patch: UpdateSchoolSettingsParams,
): Promise<SchoolSettingsRow> {
  const hasAnyField = Object.keys(patch).some(
    (k) => patch[k as keyof UpdateSchoolSettingsParams] !== undefined,
  );
  if (!hasAnyField) {
    throw new HTTPException(400, { message: "No fields to update." });
  }

  return withTenantTx(database, { schoolId }, async (tx: TransactionSql) => {
    // 1. Read current settings (the "before" snapshot for audit).
    const beforeRows = await tx<SchoolSettingsRow[]>`
      SELECT
        school_id::text,
        locale, timezone, grading_scheme,
        invitation_expiry_days,
        attendance_alert_threshold, absence_alert_threshold,
        created_at, updated_at
      FROM app.school_settings
      WHERE school_id = ${schoolId}::uuid
    `;

    const before = beforeRows[0];

    // 2. Ensure the row exists (create defaults if this is the first mutation).
    if (!before) {
      await tx`
        INSERT INTO app.school_settings (school_id)
        VALUES (${schoolId}::uuid)
      `;
    }

    // 3. Apply the patch. COALESCE keeps existing values for fields the caller omitted.
    const afterRows = await tx<SchoolSettingsRow[]>`
      UPDATE app.school_settings SET
        locale                        = COALESCE(${patch.locale ?? null}, locale),
        timezone                      = COALESCE(${patch.timezone ?? null}, timezone),
        grading_scheme                = COALESCE(${patch.grading_scheme ?? null}, grading_scheme),
        invitation_expiry_days        = COALESCE(${patch.invitation_expiry_days ?? null}, invitation_expiry_days),
        attendance_alert_threshold    = COALESCE(${patch.attendance_alert_threshold ?? null}, attendance_alert_threshold),
        absence_alert_threshold       = COALESCE(${patch.absence_alert_threshold ?? null}, absence_alert_threshold),
        updated_at                    = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}::uuid
      RETURNING
        school_id::text,
        locale, timezone, grading_scheme,
        invitation_expiry_days,
        attendance_alert_threshold, absence_alert_threshold,
        created_at, updated_at
    `;

    if (afterRows.length === 0) {
      throw new HTTPException(500, { message: "Failed to update school settings." });
    }

    const after = rowToSettings(afterRows[0]);

    // 4. Audit: before/after in the same transaction.
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "school_settings",
      targetId: schoolId,
      oldValues: before
        ? {
            locale: before.locale,
            timezone: before.timezone,
            grading_scheme: before.grading_scheme,
            invitation_expiry_days: before.invitation_expiry_days,
            attendance_alert_threshold: before.attendance_alert_threshold,
            absence_alert_threshold: before.absence_alert_threshold,
          }
        : null,
      newValues: {
        locale: after.locale,
        timezone: after.timezone,
        grading_scheme: after.grading_scheme,
        invitation_expiry_days: after.invitation_expiry_days,
        attendance_alert_threshold: after.attendance_alert_threshold,
        absence_alert_threshold: after.absence_alert_threshold,
      },
    });

    return after;
  });
}
