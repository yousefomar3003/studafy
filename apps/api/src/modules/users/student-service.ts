import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { decodeKeysetCursor, encodeKeysetCursor } from "../../lib/keyset-cursor";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { StudentStatus, CreateStudentBody, UpdateStudentBody } from "./schemas";
import type { TransactionSql } from "postgres";

type ParentRelationship =
  "mother" | "father" | "guardian" | "step_parent" | "grandparent" | "sibling" | "other";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StudentRow {
  id: string;
  school_id: string;
  user_id: string;
  admission_number: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: Date | null;
  nationality_country_id: string | null;
  admission_date: Date | null;
  status: StudentStatus;
  created_at: Date;
  updated_at: Date;
}

export interface GuardianRow {
  family_id: string;
  parent_user_id: string;
  relationship: ParentRelationship;
  created_at: Date;
}

export interface ListStudentsParams {
  limit: number;
  cursor?: string;
  status?: StudentStatus;
  search?: string;
  created_from?: string;
  created_to?: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listStudents(
  tx: TransactionSql,
  schoolId: string,
  params: ListStudentsParams,
): Promise<{ rows: StudentRow[]; next_cursor: string | null }> {
  const statusFilter = params.status
    ? tx` AND s.status = ${params.status}::app.student_status`
    : tx``;

  const searchFilter = params.search
    ? tx` AND (
        s.first_name ILIKE ${`%${params.search}%`}
        OR s.last_name ILIKE ${`%${params.search}%`}
        OR s.admission_number ILIKE ${`%${params.search}%`}
      )`
    : tx``;

  const createdFromFilter = params.created_from
    ? tx` AND s.created_at >= ${params.created_from}::timestamptz`
    : tx``;

  const createdToFilter = params.created_to
    ? tx` AND s.created_at <= ${params.created_to}::timestamptz`
    : tx``;

  const cursorFilter = params.cursor
    ? (() => {
        const { created_at, id } = decodeKeysetCursor(params.cursor);
        return tx` AND (s.created_at, s.id) < (${created_at}::timestamptz, ${id}::uuid)`;
      })()
    : tx``;

  const limit = params.limit + 1;

  const rows = await tx<StudentRow[]>`
    SELECT s.id, s.school_id, s.user_id, s.admission_number,
           s.first_name, s.middle_name, s.last_name, s.preferred_name,
           s.date_of_birth, s.nationality_country_id, s.admission_date,
           s.status, s.created_at, s.updated_at
    FROM app.students s
    WHERE s.school_id = ${schoolId}
      ${statusFilter}
      ${searchFilter}
      ${createdFromFilter}
      ${createdToFilter}
      ${cursorFilter}
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ${limit}
  `;

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, params.limit) : rows;
  const next_cursor =
    hasMore && sliced.length > 0
      ? encodeKeysetCursor(sliced[sliced.length - 1]!.created_at, sliced[sliced.length - 1]!.id)
      : null;

  return {
    rows: sliced.map((row) => ({
      ...row,
      status: row.status as StudentStatus,
    })),
    next_cursor,
  };
}

export async function getStudent(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<StudentRow | undefined> {
  const [row] = await tx<StudentRow[]>`
    SELECT s.id, s.school_id, s.user_id, s.admission_number,
           s.first_name, s.middle_name, s.last_name, s.preferred_name,
           s.date_of_birth, s.nationality_country_id, s.admission_date,
           s.status, s.created_at, s.updated_at
    FROM app.students s
    WHERE s.id = ${studentId}::uuid AND s.school_id = ${schoolId}
  `;
  if (!row) return undefined;
  return { ...row, status: row.status as StudentStatus };
}

export async function getStudentGuardians(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<GuardianRow[]> {
  const rows = await tx<GuardianRow[]>`
    SELECT pcl.family_id, pcl.parent_user_id, pcl.relationship, pcl.created_at
    FROM app.parent_child_links pcl
    WHERE pcl.student_id = ${studentId}::uuid
      AND pcl.school_id = ${schoolId}
    ORDER BY pcl.created_at ASC
  `;
  return rows;
}

export async function createStudent(
  tx: TransactionSql,
  schoolId: string,
  params: CreateStudentBody,
): Promise<StudentRow> {
  const normalizedEmail = params.email.toLowerCase().trim();
  const normalizedAdmission = params.admission_number.toLowerCase().trim();

  // Pre-check admission number for a friendly error.
  const existingAdmission = await tx<{ id: string }[]>`
    SELECT id FROM app.students
    WHERE school_id = ${schoolId}
      AND normalized_admission_number = ${normalizedAdmission}
    LIMIT 1
  `;

  if (existingAdmission.length > 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.STUDENT_ADMISSION_DUPLICATE,
      `Admission number "${params.admission_number}" is already in use.`,
    );
  }

  // Create the linked user account.
  const [user] = await tx<{ id: string }[]>`
    INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
    VALUES (
      ${schoolId},
      ${params.email},
      ${normalizedEmail},
      ${params.first_name || params.last_name},
      'active'::app.user_status
    )
    RETURNING id
  `;

  if (!user) {
    throw new HTTPException(500, { message: "Failed to create user" });
  }

  // Assign STUDENT role.
  await tx`
    INSERT INTO app.user_roles (school_id, user_id, role)
    VALUES (${schoolId}, ${user.id}, 'STUDENT'::app.user_role)
  `;

  // Create the student profile.
  let student: StudentRow | undefined;
  try {
    const [row] = await tx<StudentRow[]>`
      INSERT INTO app.students (
        school_id, user_id, admission_number, first_name, middle_name,
        last_name, preferred_name, date_of_birth, nationality_country_id,
        admission_date, status
      ) VALUES (
        ${schoolId},
        ${user.id},
        ${params.admission_number},
        ${params.first_name},
        ${params.middle_name ?? null},
        ${params.last_name},
        ${params.preferred_name ?? null},
        ${params.date_of_birth ? params.date_of_birth : null}::date,
        ${params.nationality_country_id ?? null}::uuid,
        ${params.admission_date ? params.admission_date : null}::date,
        ${params.status ?? "applicant"}::app.student_status
      )
      RETURNING id, school_id, user_id, admission_number,
                first_name, middle_name, last_name, preferred_name,
                date_of_birth, nationality_country_id, admission_date,
                status, created_at, updated_at
    `;
    student = row;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "23505"
    ) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.STUDENT_ADMISSION_DUPLICATE,
        `Admission number "${params.admission_number}" is already in use.`,
      );
    }
    throw error;
  }

  if (!student) {
    throw new HTTPException(500, { message: "Failed to create student profile" });
  }

  // Create guardian links.
  if (params.guardians && params.guardians.length > 0) {
    for (const guardian of params.guardians) {
      const familyId = await resolveGuardianFamily(
        tx,
        schoolId,
        guardian.parent_user_id,
        guardian.family_id,
      );
      await tx`
        INSERT INTO app.parent_child_links
          (school_id, family_id, parent_user_id, student_id, relationship)
        VALUES (
          ${schoolId},
          ${familyId}::uuid,
          ${guardian.parent_user_id}::uuid,
          ${student.id},
          ${guardian.relationship}::app.parent_relationship
        )
      `;
    }
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
    newValues: { role: "STUDENT" },
  });

  // Audit: student profile creation.
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "students",
    targetId: student.id,
    newValues: {
      admission_number: params.admission_number,
      first_name: params.first_name,
      last_name: params.last_name,
      status: params.status ?? "applicant",
    },
  });

  return { ...student, status: student.status as StudentStatus };
}

export async function updateStudent(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  params: UpdateStudentBody,
): Promise<StudentRow> {
  const existing = await getStudent(tx, schoolId, studentId);
  if (!existing) {
    throw new HTTPException(404, { message: "Student not found" });
  }

  // If updating admission number, pre-check uniqueness.
  if (params.admission_number !== undefined) {
    const normalizedAdmission = params.admission_number.toLowerCase().trim();
    const duplicate = await tx<{ id: string }[]>`
      SELECT id FROM app.students
      WHERE school_id = ${schoolId}
        AND normalized_admission_number = ${normalizedAdmission}
        AND id != ${studentId}::uuid
      LIMIT 1
    `;
    if (duplicate.length > 0) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.STUDENT_ADMISSION_DUPLICATE,
        `Admission number "${params.admission_number}" is already in use.`,
      );
    }
  }

  const [updated] = await tx<StudentRow[]>`
    UPDATE app.students
    SET first_name = COALESCE(${params.first_name ?? null}, first_name),
        middle_name = COALESCE(${params.middle_name ?? null}::text, middle_name),
        last_name = COALESCE(${params.last_name ?? null}, last_name),
        preferred_name = COALESCE(${params.preferred_name ?? null}::text, preferred_name),
        date_of_birth = COALESCE(${params.date_of_birth ?? null}::date, date_of_birth),
        nationality_country_id = COALESCE(
          ${params.nationality_country_id ?? null}::uuid, nationality_country_id
        ),
        admission_number = COALESCE(${params.admission_number ?? null}, admission_number),
        admission_date = COALESCE(${params.admission_date ?? null}::date, admission_date),
        status = COALESCE(${params.status ?? null}::app.student_status, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${studentId}::uuid AND school_id = ${schoolId}
    RETURNING id, school_id, user_id, admission_number,
              first_name, middle_name, last_name, preferred_name,
              date_of_birth, nationality_country_id, admission_date,
              status, created_at, updated_at
  `;

  if (!updated) {
    throw new HTTPException(404, { message: "Student not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "students",
    targetId: studentId,
    oldValues: {
      first_name: existing.first_name,
      last_name: existing.last_name,
      middle_name: existing.middle_name,
      preferred_name: existing.preferred_name,
      date_of_birth: existing.date_of_birth,
      admission_number: existing.admission_number,
      status: existing.status,
    },
    newValues: {
      first_name: updated.first_name,
      last_name: updated.last_name,
      middle_name: updated.middle_name,
      preferred_name: updated.preferred_name,
      date_of_birth: updated.date_of_birth,
      admission_number: updated.admission_number,
      status: updated.status,
    },
  });

  return { ...updated, status: updated.status as StudentStatus };
}

// ---------------------------------------------------------------------------
// Parent-child linking
// ---------------------------------------------------------------------------

async function resolveGuardianFamily(
  tx: TransactionSql,
  schoolId: string,
  parentUserId: string,
  requestedFamilyId?: string,
): Promise<string> {
  const [parent] = await tx<{ id: string }[]>`
    SELECT user_row.id
    FROM app.users AS user_row
    JOIN app.user_roles AS role
      ON role.school_id = user_row.school_id
     AND role.user_id = user_row.id
     AND role.role = 'PARENT'::app.user_role
    WHERE user_row.school_id = ${schoolId}::uuid
      AND user_row.id = ${parentUserId}::uuid
  `;
  if (!parent) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.PARENT_INVALID_ROLE,
      "User does not have the PARENT role.",
    );
  }

  if (requestedFamilyId) {
    const [family] = await tx<{ id: string }[]>`
      SELECT id
      FROM app.families
      WHERE school_id = ${schoolId}::uuid
        AND id = ${requestedFamilyId}::uuid
    `;
    if (!family) throw new HTTPException(404, { message: "Family not found" });
    return family.id;
  }

  const [existing] = await tx<{ id: string }[]>`
    SELECT family.id
    FROM app.families AS family
    WHERE family.school_id = ${schoolId}::uuid
      AND (
        family.primary_parent_user_id = ${parentUserId}::uuid
        OR EXISTS (
          SELECT 1
          FROM app.parent_child_links AS link
          WHERE link.school_id = family.school_id
            AND link.family_id = family.id
            AND link.parent_user_id = ${parentUserId}::uuid
        )
      )
    ORDER BY family.created_at, family.id
    LIMIT 1
  `;
  if (existing) return existing.id;

  const [created] = await tx<{ id: string; display_name: string }[]>`
    INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
    SELECT
      ${schoolId}::uuid,
      left(COALESCE(NULLIF(btrim(display_name), ''), 'Family'), 200),
      id
    FROM app.users
    WHERE school_id = ${schoolId}::uuid
      AND id = ${parentUserId}::uuid
    RETURNING id, display_name
  `;
  if (!created) throw new HTTPException(404, { message: "Parent user not found" });
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "families",
    targetId: created.id,
    newValues: {
      display_name: created.display_name,
      primary_parent_user_id: parentUserId,
    },
  });
  return created.id;
}

export async function linkParentToStudent(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  parentUserId: string,
  relationship: ParentRelationship,
  familyId?: string,
): Promise<GuardianRow> {
  const [student] = await tx<{ id: string }[]>`
    SELECT id FROM app.students
    WHERE id = ${studentId}::uuid AND school_id = ${schoolId}
  `;
  if (!student) {
    throw new HTTPException(404, { message: "Student not found" });
  }

  const [parent] = await tx<{ id: string }[]>`
    SELECT u.id FROM app.users u
    JOIN app.user_roles ur ON ur.user_id = u.id AND ur.school_id = u.school_id
    WHERE u.id = ${parentUserId}::uuid
      AND u.school_id = ${schoolId}
      AND ur.role = 'PARENT'::app.user_role
  `;
  if (!parent) {
    const exists = await tx<{ id: string }[]>`
      SELECT id FROM app.users
      WHERE id = ${parentUserId}::uuid AND school_id = ${schoolId}
    `;
    if (exists.length === 0) {
      throw new HTTPException(404, { message: "Parent user not found" });
    }
    throw new CodedHttpException(
      400,
      ERROR_CODES.PARENT_INVALID_ROLE,
      "User does not have the PARENT role.",
    );
  }

  const existing = await tx<{ parent_user_id: string }[]>`
    SELECT parent_user_id FROM app.parent_child_links
    WHERE school_id = ${schoolId}
      AND parent_user_id = ${parentUserId}::uuid
      AND student_id = ${studentId}::uuid
  `;
  if (existing.length > 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.PARENT_LINK_EXISTS,
      "This parent is already linked to this student.",
    );
  }

  const resolvedFamilyId = await resolveGuardianFamily(tx, schoolId, parentUserId, familyId);

  const [row] = await tx<GuardianRow[]>`
    INSERT INTO app.parent_child_links
      (school_id, family_id, parent_user_id, student_id, relationship)
    VALUES (
      ${schoolId},
      ${resolvedFamilyId}::uuid,
      ${parentUserId}::uuid,
      ${studentId}::uuid,
      ${relationship}::app.parent_relationship
    )
    RETURNING family_id, parent_user_id, relationship, created_at
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "parent_child_links",
    targetId: studentId,
    newValues: { family_id: resolvedFamilyId, parent_user_id: parentUserId, relationship },
  });

  return row!;
}

export async function unlinkParentFromStudent(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  parentUserId: string,
): Promise<void> {
  const [existing] = await tx<{ parent_user_id: string; relationship: string }[]>`
    SELECT parent_user_id, relationship FROM app.parent_child_links
    WHERE school_id = ${schoolId}
      AND parent_user_id = ${parentUserId}::uuid
      AND student_id = ${studentId}::uuid
  `;
  if (!existing) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.PARENT_NOT_LINKED,
      "No link exists between this parent and student.",
    );
  }

  await tx`
    DELETE FROM app.parent_child_links
    WHERE school_id = ${schoolId}
      AND parent_user_id = ${parentUserId}::uuid
      AND student_id = ${studentId}::uuid
  `;

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "parent_child_links",
    targetId: studentId,
    oldValues: { parent_user_id: parentUserId, relationship: existing.relationship },
  });
}
