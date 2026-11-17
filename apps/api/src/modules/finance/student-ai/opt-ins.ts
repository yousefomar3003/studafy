/**
 * The ONE place the Student AI tuition line reads opt-ins from.
 *
 * Phase 2 of the programme (opt-in and seats) owns the opt-in records: per student, the parent who
 * chose, the academic year, the licence, the start month, and whether the seat is active, released
 * (student left; charges stop from `releasedEffectiveMonth`) or transferred (to
 * `transferredToStudentId`, who gets their own opt-in from the transfer month). Everything in
 * ./service.ts reads them through `listStudentAiOptIns` and nothing else.
 *
 * TODO(ai-revshare phase 2 integration): replace the body of `listStudentAiOptIns` with a read of
 * phase 2's opt-in table, mapping its columns onto `StudentAiOptIn`, and have phase 2's
 * "opt-in created / released / transferred" events call `syncStudentAiFeeItems` (./service.ts) for
 * the student(s) concerned. Until then the temporary body below derives opt-ins from the licence's
 * student seats so the line can be built and tested end to end: every assigned student seat is an
 * opt-in from the month it was assigned, and an unassigned seat is released from the month after.
 * It must not ship on its own: it would bill every seat holder.
 */

import type { TransactionSql } from "postgres";

export type StudentAiOptInStatus = "active" | "released" | "transferred";

export interface StudentAiOptIn {
  studentId: string;
  /** The parents who chose (or for whom the school recorded the choice). */
  parentUserIds: string[];
  academicYearId: string;
  licenceId: string;
  /** First day of the first month the student has Student AI, ISO date. */
  startMonth: string;
  status: StudentAiOptInStatus;
  /** First day of the first month no longer charged (released or transferred), ISO date. */
  releasedEffectiveMonth: string | null;
  /** The student a transferred seat went to. */
  transferredToStudentId: string | null;
}

export interface StudentAiOptInFilters {
  studentIds?: readonly string[];
  academicYearId?: string;
}

/**
 * The school's Student AI opt-ins, oldest first. Must run with the school armed in a transaction
 * that can read the school's licences and students (the reconciliation's system transaction).
 */
export async function listStudentAiOptIns(
  tx: TransactionSql,
  schoolId: string,
  filters: StudentAiOptInFilters = {},
): Promise<StudentAiOptIn[]> {
  // TEMPORARY (see the TODO above): derived from the licence's student seats.
  const studentFilter = filters.studentIds
    ? tx` AND seat.student_id = ANY(${[...filters.studentIds]}::uuid[])`
    : tx``;
  const yearFilter = filters.academicYearId
    ? tx` AND year.id = ${filters.academicYearId}::uuid`
    : tx``;

  const rows = await tx<
    {
      student_id: string;
      parent_user_ids: string[] | null;
      academic_year_id: string;
      license_id: string;
      start_month: string;
      unassigned_month: string | null;
    }[]
  >`
    SELECT seat.student_id,
           (SELECT array_agg(DISTINCT link.parent_user_id ORDER BY link.parent_user_id)
            FROM app.parent_child_links AS link
            WHERE link.school_id = seat.school_id AND link.student_id = seat.student_id)
             AS parent_user_ids,
           year.id AS academic_year_id,
           seat.license_id,
           date_trunc('month', seat.assigned_at)::date::text AS start_month,
           CASE WHEN seat.unassigned_at IS NULL THEN NULL
                ELSE (date_trunc('month', seat.unassigned_at) + interval '1 month')::date::text
           END AS unassigned_month
    FROM app.license_seats AS seat
    JOIN app.school_licenses AS licence
      ON licence.id = seat.license_id AND licence.school_id = seat.school_id
    -- The academic year the seat was assigned in (the latest-starting one when years overlap), or,
    -- assigned before any year began, the next one.
    JOIN LATERAL (
      SELECT ay.id
      FROM app.academic_years AS ay
      WHERE ay.school_id = seat.school_id AND ay.ends_on >= seat.assigned_at::date
      ORDER BY (ay.starts_on <= seat.assigned_at::date) DESC,
               CASE WHEN ay.starts_on <= seat.assigned_at::date THEN ay.starts_on END DESC,
               ay.starts_on ASC
      LIMIT 1
    ) AS year ON true
    WHERE seat.school_id = ${schoolId}::uuid
      AND seat.audience = 'student'
      AND seat.student_id IS NOT NULL
      AND licence.status IN ('active', 'suspended', 'expired')
      ${studentFilter}
      ${yearFilter}
    ORDER BY seat.assigned_at, seat.id
  `;

  return rows.map((row) => ({
    studentId: row.student_id,
    parentUserIds: row.parent_user_ids ?? [],
    academicYearId: row.academic_year_id,
    licenceId: row.license_id,
    startMonth: row.start_month,
    status: row.unassigned_month === null ? "active" : "released",
    releasedEffectiveMonth: row.unassigned_month,
    transferredToStudentId: null,
  }));
}
