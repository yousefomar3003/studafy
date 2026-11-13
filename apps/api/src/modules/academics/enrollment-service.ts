import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { EnrollmentStatus } from "./schemas";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnrollmentRow {
  school_id: string;
  class_id: string;
  student_id: string;
  status: EnrollmentStatus;
  enrolled_at: Date;
  withdrawn_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListEnrollmentsParams {
  limit: number;
  offset: number;
  status?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function countActiveEnrollments(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
): Promise<number> {
  const [{ count }] = await tx<{ count: string }[]>`
    SELECT count(*)::int AS count
    FROM app.enrollments
    WHERE class_id = ${classId} AND school_id = ${schoolId}
      AND status IN ('active', 'waitlisted')
  `;
  return Number(count);
}

async function getClassCapacity(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
): Promise<{ capacity: number | null } | undefined> {
  const [row] = await tx<{ capacity: number | null }[]>`
    SELECT capacity FROM app.classes
    WHERE id = ${classId} AND school_id = ${schoolId}
  `;
  return row;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listEnrollments(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
  params: ListEnrollmentsParams,
): Promise<{ rows: EnrollmentRow[]; total: number }> {
  const statusFilter = params.status
    ? tx` AND e.status = ${params.status}::app.enrollment_status`
    : tx``;

  const [rows, countResult] = await Promise.all([
    tx<EnrollmentRow[]>`
      SELECT e.school_id, e.class_id, e.student_id, e.status,
             e.enrolled_at, e.withdrawn_at, e.created_at, e.updated_at
      FROM app.enrollments AS e
      WHERE e.school_id = ${schoolId} AND e.class_id = ${classId}
        ${statusFilter}
      ORDER BY e.enrolled_at DESC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.enrollments AS e
      WHERE e.school_id = ${schoolId} AND e.class_id = ${classId}
        ${statusFilter}
    `,
  ]);

  return { rows, total: Number(countResult[0]?.count ?? 0) };
}

export async function getEnrollment(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
  studentId: string,
): Promise<EnrollmentRow | undefined> {
  const [row] = await tx<EnrollmentRow[]>`
    SELECT school_id, class_id, student_id, status,
           enrolled_at, withdrawn_at, created_at, updated_at
    FROM app.enrollments
    WHERE class_id = ${classId} AND student_id = ${studentId} AND school_id = ${schoolId}
  `;
  return row;
}

export async function enrollStudent(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
  studentId: string,
): Promise<EnrollmentRow> {
  const cls = await getClassCapacity(tx, schoolId, classId);
  if (!cls) {
    throw new HTTPException(404, { message: "Class not found" });
  }

  const [student] = await tx<{ id: string }[]>`
    SELECT id FROM app.students
    WHERE id = ${studentId} AND school_id = ${schoolId}
  `;
  if (!student) {
    throw new HTTPException(404, { message: "Student not found" });
  }

  const existing = await getEnrollment(tx, schoolId, classId, studentId);
  if (existing) {
    if (existing.status === "active" || existing.status === "waitlisted") {
      throw new CodedHttpException(
        409,
        ERROR_CODES.ENROLLMENT_DUPLICATE,
        "Student is already enrolled in this class.",
      );
    }
    // Re-enroll: student was previously withdrawn/completed/cancelled
    if (cls.capacity !== null) {
      const enrolled = await countActiveEnrollments(tx, schoolId, classId);
      if (enrolled >= cls.capacity) {
        throw new CodedHttpException(
          409,
          ERROR_CODES.CLASS_CAPACITY_EXCEEDED,
          "Class has reached its enrollment capacity.",
        );
      }
    }

    const [row] = await tx<EnrollmentRow[]>`
      UPDATE app.enrollments
      SET status = 'active'::app.enrollment_status,
          enrolled_at = CURRENT_TIMESTAMP,
          withdrawn_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE class_id = ${classId} AND student_id = ${studentId} AND school_id = ${schoolId}
      RETURNING school_id, class_id, student_id, status,
                enrolled_at, withdrawn_at, created_at, updated_at
    `;

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "enrollments",
      targetId: classId,
      newValues: { student_id: studentId, action: "re_enroll" },
    });

    return row!;
  }

  if (cls.capacity !== null) {
    const enrolled = await countActiveEnrollments(tx, schoolId, classId);
    if (enrolled >= cls.capacity) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.CLASS_CAPACITY_EXCEEDED,
        "Class has reached its enrollment capacity.",
      );
    }
  }

  const [row] = await tx<EnrollmentRow[]>`
    INSERT INTO app.enrollments (school_id, class_id, student_id, status)
    VALUES (${schoolId}, ${classId}, ${studentId}, 'active'::app.enrollment_status)
    RETURNING school_id, class_id, student_id, status,
              enrolled_at, withdrawn_at, created_at, updated_at
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "enrollments",
    targetId: classId,
    newValues: { student_id: studentId },
  });

  return row!;
}

export async function withdrawStudent(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
  studentId: string,
): Promise<EnrollmentRow> {
  const existing = await getEnrollment(tx, schoolId, classId, studentId);
  if (!existing) {
    throw new HTTPException(404, { message: "Enrollment not found" });
  }
  if (existing.status !== "active" && existing.status !== "waitlisted") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.ENROLLMENT_NOT_ACTIVE,
      `Cannot withdraw: enrollment is already ${existing.status}.`,
    );
  }

  const [row] = await tx<EnrollmentRow[]>`
    UPDATE app.enrollments
    SET status = 'withdrawn'::app.enrollment_status,
        withdrawn_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE class_id = ${classId} AND student_id = ${studentId} AND school_id = ${schoolId}
    RETURNING school_id, class_id, student_id, status,
              enrolled_at, withdrawn_at, created_at, updated_at
  `;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "enrollments",
    targetId: classId,
    oldValues: { status: existing.status },
    newValues: { student_id: studentId, status: "withdrawn" },
  });

  return row!;
}

/**
 * Transfer a student from one class to another within the same school.
 *
 * 1. Withdraw from source class (preserves history).
 * 2. Enroll in destination class (capacity check applied).
 *
 * Both operations happen in the caller's transaction, so they are atomic.
 */
export async function transferStudent(
  tx: TransactionSql,
  schoolId: string,
  fromClassId: string,
  toClassId: string,
  studentId: string,
): Promise<{ source: EnrollmentRow; destination: EnrollmentRow }> {
  const source = await withdrawStudent(tx, schoolId, fromClassId, studentId);
  const destination = await enrollStudent(tx, schoolId, toClassId, studentId);

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "enrollments",
    targetId: fromClassId,
    newValues: {
      student_id: studentId,
      action: "transfer",
      from_class_id: fromClassId,
      to_class_id: toClassId,
    },
  });

  return { source, destination };
}
