import type { TransactionSql } from "postgres";

/**
 * Whether a student is provided for by a school seat, so they are never sold a personal AI
 * purchase (owner, 2026-11-18: "students who have a seat offered by the school can never
 * subscribe"). A student seat covers them when it is still assigned and either:
 *
 *   - its licence is in force (status active and the clock inside the licence period) -- the grant
 *     adapter's rule, so this is exactly when the seat gives them the student tier; or
 *   - it holds a Student AI programme opt-in that is active, on a licence that takes opt-ins
 *     (active or awaiting payment) and has not ended -- including one that has not started yet:
 *     the school has committed the seat, so the family is not sold the same thing in the app.
 *
 * A student without such a seat -- even at a school that sells seats or runs the programme -- is
 * free to buy the add-on in the app (owner, 2026-11-18: parents choose the school or the app).
 *
 * Read in a transaction scoped to `schoolId` that can see the school's seats (a system
 * transaction, or the school's own staff); the school is also pinned in the query.
 */
export interface StudentSchoolSeat {
  seatId: string;
  licenseId: string;
  userId: string;
  studentId: string;
  /** True when the licence is in force now; false for a programme seat waiting for it to start. */
  inForce: boolean;
}

export async function studentSchoolSeat(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  now: Date = new Date(),
): Promise<StudentSchoolSeat | null> {
  const [row] = await tx<
    {
      seat_id: string;
      license_id: string;
      user_id: string;
      student_id: string;
      in_force: boolean;
    }[]
  >`
    SELECT ls.id::text AS seat_id, ls.license_id::text AS license_id, s.user_id::text AS user_id,
           s.id::text AS student_id,
           (l.status = 'active' AND l.starts_at <= ${now} AND l.ends_at > ${now}) AS in_force
    FROM app.students AS s
    JOIN app.license_seats AS ls
      ON ls.school_id = s.school_id AND ls.user_id = s.user_id
     AND ls.audience = 'student' AND ls.unassigned_at IS NULL
    JOIN app.school_licenses AS l ON l.id = ls.license_id AND l.school_id = ls.school_id
    WHERE s.school_id = ${schoolId}::uuid
      AND s.id = ${studentId}::uuid
      AND l.ends_at > ${now}
      AND (
        (l.status = 'active' AND l.starts_at <= ${now})
        OR (
          l.status IN ('active', 'awaiting_payment')
          AND EXISTS (
            SELECT 1 FROM app.ai_optins AS o
            WHERE o.school_id = ls.school_id AND o.seat_id = ls.id AND o.status = 'active'
          )
        )
      )
    ORDER BY in_force DESC, ls.assigned_at
    LIMIT 1
  `;
  return row
    ? {
        seatId: row.seat_id,
        licenseId: row.license_id,
        userId: row.user_id,
        studentId: row.student_id,
        inForce: row.in_force,
      }
    : null;
}
