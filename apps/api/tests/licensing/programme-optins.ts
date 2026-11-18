import type { TransactionSql } from "postgres";

/**
 * Test helpers for the Student AI programme's opt-ins (phase 2, 000235), written straight into the
 * tables the way the service writes them, for suites that need a school "in the programme" (the
 * tuition line, upload consistency, the revenue share) without driving the opt-in routes. Run in a
 * transaction armed for the school as studafy_admin.
 */

/** An opt-in window on the licence for the year (closed, so it never blocks one a test opens). */
export async function insertOptInWindow(
  tx: TransactionSql,
  input: {
    schoolId: string;
    licenseId: string;
    academicYearId: string;
    openedBy: string;
    opensOn?: string;
    closesOn?: string;
  },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.ai_optin_windows
      (school_id, license_id, academic_year_id, opens_on, closes_on, opened_by, closed_at, closed_by)
    VALUES (${input.schoolId}::uuid, ${input.licenseId}::uuid, ${input.academicYearId}::uuid,
            ${input.opensOn ?? "2000-01-01"}::date, ${input.closesOn ?? "2000-01-02"}::date,
            ${input.openedBy}::uuid, CURRENT_TIMESTAMP, ${input.openedBy}::uuid)
    RETURNING id::text AS id
  `;
  return row!.id;
}

export interface TestOptInInput {
  schoolId: string;
  licenseId: string;
  academicYearId: string;
  windowId: string;
  studentId: string;
  recordedBy: string;
  /** First days of months. */
  startMonth: string;
  endMonth: string;
  monthlyPriceMinor: number;
  currencyCode?: string;
  seatId?: string | null;
  seatAssignedAt?: string;
  optedInAt?: string;
}

/** An active opt-in recorded on a parent's behalf (holding `seatId`, when given). */
export async function insertOptIn(tx: TransactionSql, input: TestOptInInput): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.ai_optins (
      school_id, student_id, academic_year_id, license_id, window_id, source, parent_user_id,
      recorded_by, note, terms_version, opted_in_at, start_month, end_month, months, currency_id,
      monthly_price_minor, total_minor, seat_id, seat_assigned_at
    )
    SELECT ${input.schoolId}::uuid, ${input.studentId}::uuid, ${input.academicYearId}::uuid,
           ${input.licenseId}::uuid, ${input.windowId}::uuid, 'school_on_behalf', NULL,
           ${input.recordedBy}::uuid, 'Paper form', '2026-11-17',
           ${input.optedInAt ?? new Date().toISOString()}::timestamptz,
           ${input.startMonth}::date, ${input.endMonth}::date, m.months, c.id,
           ${input.monthlyPriceMinor}, ${input.monthlyPriceMinor} * m.months,
           ${input.seatId ?? null}::uuid,
           ${input.seatId ? (input.seatAssignedAt ?? new Date().toISOString()) : null}::timestamptz
    FROM app.currencies AS c,
         LATERAL (
           SELECT (EXTRACT(YEAR FROM ${input.endMonth}::date)::int * 12
                   + EXTRACT(MONTH FROM ${input.endMonth}::date)::int)
                - (EXTRACT(YEAR FROM ${input.startMonth}::date)::int * 12
                   + EXTRACT(MONTH FROM ${input.startMonth}::date)::int) + 1 AS months
         ) AS m
    WHERE c.code = ${input.currencyCode ?? "USD"}
    RETURNING id::text AS id
  `;
  return row!.id;
}

/** End an opt-in: released from `effectiveMonth` (the first month no longer charged). */
export async function releaseTestOptIn(
  tx: TransactionSql,
  optInId: string,
  endedBy: string,
  effectiveMonth: string,
  endedAt?: string,
): Promise<void> {
  await tx`
    UPDATE app.ai_optins
    SET status = 'released', ended_at = ${endedAt ?? new Date().toISOString()}::timestamptz,
        ended_by = ${endedBy}::uuid, end_note = 'Left the school',
        released_effective_month = ${effectiveMonth}::date
    WHERE id = ${optInId}::uuid
  `;
}

/**
 * Transfer an opt-in's seat to another student on `transferredAt` (the student left): the receiver
 * gets a `transfer` opt-in at the same monthly price from `receiverStartMonth` (the month after the
 * transfer, as the service sets it) to `endMonth`, and the leaver's opt-in is marked transferred.
 */
export async function transferTestOptIn(
  tx: TransactionSql,
  input: {
    fromOptInId: string;
    toStudentId: string;
    endedBy: string;
    receiverStartMonth: string;
    transferredAt?: string;
  },
): Promise<string> {
  const at = input.transferredAt ?? new Date().toISOString();
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.ai_optins (
      school_id, student_id, academic_year_id, license_id, window_id, source, parent_user_id,
      recorded_by, note, terms_version, opted_in_at, start_month, end_month, months, currency_id,
      monthly_price_minor, total_minor, transferred_from_id
    )
    SELECT f.school_id, ${input.toStudentId}::uuid, f.academic_year_id, f.license_id, f.window_id,
           'transfer', NULL, ${input.endedBy}::uuid, 'Seat of a student who left', f.terms_version,
           ${at}::timestamptz, ${input.receiverStartMonth}::date, f.end_month, m.months,
           f.currency_id, f.monthly_price_minor, f.monthly_price_minor * m.months, f.id
    FROM app.ai_optins AS f,
         LATERAL (
           SELECT (EXTRACT(YEAR FROM f.end_month)::int * 12 + EXTRACT(MONTH FROM f.end_month)::int)
                - (EXTRACT(YEAR FROM ${input.receiverStartMonth}::date)::int * 12
                   + EXTRACT(MONTH FROM ${input.receiverStartMonth}::date)::int) + 1 AS months
         ) AS m
    WHERE f.id = ${input.fromOptInId}::uuid
    RETURNING id::text AS id
  `;
  await tx`
    UPDATE app.ai_optins
    SET status = 'transferred', ended_at = ${at}::timestamptz, ended_by = ${input.endedBy}::uuid,
        end_note = 'Left the school', transferred_to_id = ${row!.id}::uuid
    WHERE id = ${input.fromOptInId}::uuid
  `;
  return row!.id;
}

/**
 * A school's programme override that sets only its prices (per seat per month, in minor units):
 * for suites that want explicit prices rather than the global defaults (version 1: parents $4,
 * licence $4). Returns the override id; stamp a licence with it (`ai_programme_override_id`) for
 * the licence to use these prices. `createdBy` is any user of `createdBySchoolId`.
 */
export async function insertPriceOverride(
  tx: TransactionSql,
  input: {
    schoolId: string;
    createdBy: string;
    createdBySchoolId: string;
    parentPriceMinor: number;
    licensePriceMinor: number;
    currencyCode?: string;
  },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.ai_programme_school_overrides (
      school_id, version_number, price_currency_id, license_price_minor, parent_price_minor,
      reason, created_by, created_by_school_id
    )
    SELECT ${input.schoolId}::uuid,
           COALESCE((SELECT max(version_number) FROM app.ai_programme_school_overrides
                     WHERE school_id = ${input.schoolId}::uuid), 0) + 1,
           c.id, ${input.licensePriceMinor}, ${input.parentPriceMinor}, 'Test prices',
           ${input.createdBy}::uuid, ${input.createdBySchoolId}::uuid
    FROM app.currencies AS c WHERE c.code = ${input.currencyCode ?? "USD"}
    RETURNING id::text AS id
  `;
  return row!.id;
}
