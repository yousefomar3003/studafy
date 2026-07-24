import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { TeacherEmploymentStatus, CreateTeacherBody, UpdateTeacherBody } from "./schemas";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeacherRow {
  id: string;
  school_id: string;
  user_id: string;
  employee_number: string;
  employment_status: TeacherEmploymentStatus;
  hire_date: Date | null;
  termination_date: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListTeachersParams {
  limit: number;
  cursor?: string;
  status?: TeacherEmploymentStatus;
  search?: string;
  created_from?: string;
  created_to?: string;
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ created_at: createdAt.toISOString(), id })).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { created_at: string; id: string } {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      typeof decoded.created_at !== "string" ||
      typeof decoded.id !== "string"
    ) {
      throw new Error("invalid cursor shape");
    }
    return decoded;
  } catch {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, "Invalid pagination cursor");
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listTeachers(
  tx: TransactionSql,
  schoolId: string,
  params: ListTeachersParams,
): Promise<{ rows: TeacherRow[]; next_cursor: string | null }> {
  const statusFilter = params.status
    ? tx` AND t.employment_status = ${params.status}::app.teacher_employment_status`
    : tx``;

  const searchFilter = params.search
    ? tx` AND t.employee_number ILIKE ${`%${params.search}%`}`
    : tx``;

  const createdFromFilter = params.created_from
    ? tx` AND t.created_at >= ${params.created_from}::timestamptz`
    : tx``;

  const createdToFilter = params.created_to
    ? tx` AND t.created_at <= ${params.created_to}::timestamptz`
    : tx``;

  const cursorFilter = params.cursor
    ? (() => {
        const { created_at, id } = decodeCursor(params.cursor);
        return tx` AND (t.created_at, t.id) < (${created_at}::timestamptz, ${id}::uuid)`;
      })()
    : tx``;

  const limit = params.limit + 1;

  const rows = await tx<TeacherRow[]>`
    SELECT t.id, t.school_id, t.user_id, t.employee_number,
           t.employment_status, t.hire_date, t.termination_date,
           t.created_at, t.updated_at
    FROM app.teachers t
    WHERE t.school_id = ${schoolId}
      ${statusFilter}
      ${searchFilter}
      ${createdFromFilter}
      ${createdToFilter}
      ${cursorFilter}
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ${limit}
  `;

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, params.limit) : rows;
  const next_cursor =
    hasMore && sliced.length > 0
      ? encodeCursor(sliced[sliced.length - 1]!.created_at, sliced[sliced.length - 1]!.id)
      : null;

  return {
    rows: sliced.map((row) => ({
      ...row,
      employment_status: row.employment_status as TeacherEmploymentStatus,
    })),
    next_cursor,
  };
}

export async function getTeacher(
  tx: TransactionSql,
  schoolId: string,
  teacherId: string,
): Promise<TeacherRow | undefined> {
  const [row] = await tx<TeacherRow[]>`
    SELECT t.id, t.school_id, t.user_id, t.employee_number,
           t.employment_status, t.hire_date, t.termination_date,
           t.created_at, t.updated_at
    FROM app.teachers t
    WHERE t.id = ${teacherId}::uuid AND t.school_id = ${schoolId}
  `;
  if (!row) return undefined;
  return { ...row, employment_status: row.employment_status as TeacherEmploymentStatus };
}

export async function getTeacherByUserId(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
): Promise<TeacherRow | undefined> {
  const [row] = await tx<TeacherRow[]>`
    SELECT t.id, t.school_id, t.user_id, t.employee_number,
           t.employment_status, t.hire_date, t.termination_date,
           t.created_at, t.updated_at
    FROM app.teachers t
    WHERE t.user_id = ${userId}::uuid AND t.school_id = ${schoolId}
  `;
  if (!row) return undefined;
  return { ...row, employment_status: row.employment_status as TeacherEmploymentStatus };
}

export async function createTeacher(
  tx: TransactionSql,
  schoolId: string,
  params: CreateTeacherBody,
): Promise<TeacherRow> {
  const normalizedEmail = params.email.toLowerCase().trim();
  const normalizedEmployeeNumber = params.employee_number.toLowerCase().trim();

  // Pre-check employee number for a friendly error.
  const existingEmployee = await tx<{ id: string }[]>`
    SELECT id FROM app.teachers
    WHERE school_id = ${schoolId}
      AND normalized_employee_number = ${normalizedEmployeeNumber}
    LIMIT 1
  `;

  if (existingEmployee.length > 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.TEACHER_EMPLOYEE_NUMBER_DUPLICATE,
      `Employee number "${params.employee_number}" is already in use.`,
    );
  }

  // Create the linked user account.
  const [user] = await tx<{ id: string }[]>`
    INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
    VALUES (
      ${schoolId},
      ${params.email},
      ${normalizedEmail},
      ${params.email},
      'active'::app.user_status
    )
    RETURNING id
  `;

  if (!user) {
    throw new HTTPException(500, { message: "Failed to create user" });
  }

  // Assign INSTRUCTOR role.
  await tx`
    INSERT INTO app.user_roles (school_id, user_id, role)
    VALUES (${schoolId}, ${user.id}, 'INSTRUCTOR'::app.user_role)
  `;

  // Create the teacher profile.
  let teacher: TeacherRow | undefined;
  try {
    const [row] = await tx<TeacherRow[]>`
      INSERT INTO app.teachers (
        school_id, user_id, employee_number, employment_status, hire_date
      ) VALUES (
        ${schoolId},
        ${user.id},
        ${params.employee_number},
        ${params.employment_status}::app.teacher_employment_status,
        ${params.hire_date ? params.hire_date : null}::date
      )
      RETURNING id, school_id, user_id, employee_number,
                employment_status, hire_date, termination_date,
                created_at, updated_at
    `;
    teacher = row;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "23505"
    ) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.TEACHER_EMPLOYEE_NUMBER_DUPLICATE,
        `Employee number "${params.employee_number}" is already in use.`,
      );
    }
    throw error;
  }

  if (!teacher) {
    throw new HTTPException(500, { message: "Failed to create teacher profile" });
  }

  // Audit: user creation.
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "users",
    targetId: user.id,
    newValues: { email: params.email, status: "active" },
  });

  // Audit: role assignment.
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "user_roles",
    targetId: user.id,
    newValues: { role: "INSTRUCTOR" },
  });

  // Audit: teacher profile creation.
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "teachers",
    targetId: teacher.id,
    newValues: {
      employee_number: params.employee_number,
      employment_status: params.employment_status,
    },
  });

  return { ...teacher, employment_status: teacher.employment_status as TeacherEmploymentStatus };
}

export async function updateTeacher(
  tx: TransactionSql,
  schoolId: string,
  teacherId: string,
  params: UpdateTeacherBody,
): Promise<TeacherRow> {
  const existing = await getTeacher(tx, schoolId, teacherId);
  if (!existing) {
    throw new HTTPException(404, { message: "Teacher not found" });
  }

  // If updating employee number, pre-check uniqueness.
  if (params.employee_number !== undefined) {
    const normalizedEmployeeNumber = params.employee_number.toLowerCase().trim();
    const duplicate = await tx<{ id: string }[]>`
      SELECT id FROM app.teachers
      WHERE school_id = ${schoolId}
        AND normalized_employee_number = ${normalizedEmployeeNumber}
        AND id != ${teacherId}::uuid
      LIMIT 1
    `;
    if (duplicate.length > 0) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.TEACHER_EMPLOYEE_NUMBER_DUPLICATE,
        `Employee number "${params.employee_number}" is already in use.`,
      );
    }
  }

  const [updated] = await tx<TeacherRow[]>`
    UPDATE app.teachers
    SET employee_number = COALESCE(${params.employee_number ?? null}, employee_number),
        employment_status = COALESCE(
          ${params.employment_status ?? null}::app.teacher_employment_status, employment_status
        ),
        hire_date = COALESCE(${params.hire_date ?? null}::date, hire_date),
        termination_date = COALESCE(${params.termination_date ?? null}::date, termination_date),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${teacherId}::uuid AND school_id = ${schoolId}
    RETURNING id, school_id, user_id, employee_number,
              employment_status, hire_date, termination_date,
              created_at, updated_at
  `;

  if (!updated) {
    throw new HTTPException(404, { message: "Teacher not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "teachers",
    targetId: teacherId,
    oldValues: {
      employee_number: existing.employee_number,
      employment_status: existing.employment_status,
      hire_date: existing.hire_date,
      termination_date: existing.termination_date,
    },
    newValues: {
      employee_number: updated.employee_number,
      employment_status: updated.employment_status,
      hire_date: updated.hire_date,
      termination_date: updated.termination_date,
    },
  });

  return { ...updated, employment_status: updated.employment_status as TeacherEmploymentStatus };
}
