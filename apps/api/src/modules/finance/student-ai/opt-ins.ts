/**
 * The ONE place the Student AI tuition line reads opt-ins from: phase 2's `app.ai_optins` (000235).
 *
 * Per student and academic year: the parent who chose (or for whom the school recorded the choice),
 * the licence, the start month, the monthly price the parent agreed to, and whether the opt-in is
 * active, released (the student left; charges stop from `released_effective_month`) or transferred
 * (to another student, whose own `transfer` opt-in starts the month after the transfer -- so the
 * leaving student is charged through the transfer month and no month is charged twice). Everything
 * in ./service.ts reads them through `listStudentAiOptIns` and nothing else, and phase 2's opt-in,
 * release and transfer call `syncStudentAiFeeItems` for the students concerned once they commit.
 *
 * Opt-ins are per academic year: parents choose again each new year, so a new year (or a licence
 * renewal) never carries a line over.
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
  /** What the parent agreed to per month, in `currencyId` (fixed on the opt-in). */
  monthlyPriceMinor: number;
  currencyId: string;
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
  const studentFilter = filters.studentIds
    ? tx` AND o.student_id = ANY(${[...filters.studentIds]}::uuid[])`
    : tx``;
  const yearFilter = filters.academicYearId
    ? tx` AND o.academic_year_id = ${filters.academicYearId}::uuid`
    : tx``;

  const rows = await tx<
    {
      student_id: string;
      parent_user_ids: string[] | null;
      academic_year_id: string;
      license_id: string;
      start_month: string;
      status: StudentAiOptInStatus;
      stop_month: string | null;
      transferred_to_student_id: string | null;
      monthly_price_minor: string;
      currency_id: string;
    }[]
  >`
    SELECT o.student_id::text AS student_id,
           -- The parent who confirmed it, else every parent linked to the child.
           CASE WHEN o.parent_user_id IS NOT NULL THEN ARRAY[o.parent_user_id::text]
                ELSE (SELECT array_agg(DISTINCT link.parent_user_id::text
                                       ORDER BY link.parent_user_id::text)
                      FROM app.parent_child_links AS link
                      WHERE link.school_id = o.school_id AND link.student_id = o.student_id)
           END AS parent_user_ids,
           o.academic_year_id::text AS academic_year_id,
           o.license_id::text AS license_id,
           o.start_month::text AS start_month,
           o.status,
           -- The first month no longer charged: a release's effective month, or for a transfer the
           -- month the receiving student's opt-in starts (the month after the transfer).
           CASE o.status
             WHEN 'released' THEN o.released_effective_month::text
             WHEN 'transferred' THEN receiver.start_month::text
           END AS stop_month,
           receiver.student_id::text AS transferred_to_student_id,
           o.monthly_price_minor::text AS monthly_price_minor,
           o.currency_id::text AS currency_id
    FROM app.ai_optins AS o
    LEFT JOIN app.ai_optins AS receiver
      ON receiver.school_id = o.school_id AND receiver.id = o.transferred_to_id
    WHERE o.school_id = ${schoolId}::uuid
      ${studentFilter}
      ${yearFilter}
    ORDER BY o.opted_in_at, o.id
  `;

  return rows.map((row) => ({
    studentId: row.student_id,
    parentUserIds: row.parent_user_ids ?? [],
    academicYearId: row.academic_year_id,
    licenceId: row.license_id,
    startMonth: row.start_month,
    status: row.status,
    releasedEffectiveMonth: row.stop_month,
    transferredToStudentId: row.transferred_to_student_id,
    monthlyPriceMinor: Number(row.monthly_price_minor),
    currencyId: row.currency_id,
  }));
}
