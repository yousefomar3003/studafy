import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { enrollStudent, withdrawStudent } from "./enrollment-service";

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GradeLevelRow {
  id: string;
  school_id: string;
  name: string;
  sort_order: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SectionRow {
  id: string;
  school_id: string;
  academic_year_id: string;
  grade_level_id: string;
  grade_level_name: string;
  name: string;
  student_count: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SectionStudentRow {
  student_id: string;
  section_id: string;
  academic_year_id: string;
  first_name: string;
  last_name: string;
  admission_number: string;
}

export interface ListSectionsParams {
  limit: number;
  offset: number;
  academic_year_id?: string;
  grade_level_id?: string;
}

export interface PlacementResult {
  student: SectionStudentRow;
  enrolled_class_ids: string[];
  skipped_class_ids: string[];
}

// ---------------------------------------------------------------------------
// Grade levels
// ---------------------------------------------------------------------------

export async function listGradeLevels(
  tx: TransactionSql,
  schoolId: string,
): Promise<{ rows: GradeLevelRow[]; total: number }> {
  const rows = await tx<GradeLevelRow[]>`
    SELECT id, school_id, name, sort_order, archived_at, created_at, updated_at
    FROM app.grade_levels
    WHERE school_id = ${schoolId}
    ORDER BY sort_order ASC, name ASC
  `;
  return { rows, total: rows.length };
}

export async function createGradeLevel(
  tx: TransactionSql,
  schoolId: string,
  params: { name: string; sort_order: number },
): Promise<GradeLevelRow> {
  const [row] = await tx<GradeLevelRow[]>`
    INSERT INTO app.grade_levels (school_id, name, sort_order)
    VALUES (${schoolId}, ${params.name}, ${params.sort_order})
    RETURNING id, school_id, name, sort_order, archived_at, created_at, updated_at
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "grade_levels",
    targetId: row!.id,
    newValues: { name: params.name },
  });

  return row!;
}

export async function updateGradeLevel(
  tx: TransactionSql,
  schoolId: string,
  gradeLevelId: string,
  params: { name?: string; sort_order?: number; archived?: boolean },
): Promise<GradeLevelRow> {
  const [row] = await tx<GradeLevelRow[]>`
    UPDATE app.grade_levels
    SET name = COALESCE(${params.name ?? null}, name),
        sort_order = COALESCE(${params.sort_order ?? null}::smallint, sort_order),
        archived_at = CASE ${params.archived ?? null}::boolean
          WHEN true THEN COALESCE(archived_at, CURRENT_TIMESTAMP)
          WHEN false THEN NULL
          ELSE archived_at
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${gradeLevelId} AND school_id = ${schoolId}
    RETURNING id, school_id, name, sort_order, archived_at, created_at, updated_at
  `;
  if (!row) {
    throw new HTTPException(404, { message: "Grade level not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "grade_levels",
    targetId: gradeLevelId,
    newValues: { ...params },
  });

  return row;
}

export async function deleteGradeLevel(
  tx: TransactionSql,
  schoolId: string,
  gradeLevelId: string,
): Promise<void> {
  const [{ count }] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.sections
    WHERE grade_level_id = ${gradeLevelId} AND school_id = ${schoolId}
  `;
  if (Number(count) > 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.GRADE_LEVEL_HAS_SECTIONS,
      "Delete this grade's sections first.",
    );
  }

  const deleted = await tx`
    DELETE FROM app.grade_levels
    WHERE id = ${gradeLevelId} AND school_id = ${schoolId}
    RETURNING id
  `;
  if (deleted.length === 0) {
    throw new HTTPException(404, { message: "Grade level not found" });
  }

  await emitAuditLog(tx, { action: "delete", targetTable: "grade_levels", targetId: gradeLevelId });
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const sectionColumns = (tx: TransactionSql) => tx`
  s.id, s.school_id, s.academic_year_id, s.grade_level_id, g.name AS grade_level_name, s.name,
  (
    SELECT count(*)::int FROM app.student_sections AS ss
    WHERE ss.section_id = s.id AND ss.school_id = s.school_id
  ) AS student_count,
  s.archived_at, s.created_at, s.updated_at
`;

export async function listSections(
  tx: TransactionSql,
  schoolId: string,
  params: ListSectionsParams,
): Promise<{ rows: SectionRow[]; total: number }> {
  const yearFilter = params.academic_year_id
    ? tx` AND s.academic_year_id = ${params.academic_year_id}`
    : tx``;
  const gradeFilter = params.grade_level_id
    ? tx` AND s.grade_level_id = ${params.grade_level_id}`
    : tx``;

  const [rows, countResult] = await Promise.all([
    tx<SectionRow[]>`
      SELECT ${sectionColumns(tx)}
      FROM app.sections AS s
      JOIN app.grade_levels AS g ON g.id = s.grade_level_id AND g.school_id = s.school_id
      WHERE s.school_id = ${schoolId}
        ${yearFilter}
        ${gradeFilter}
      ORDER BY g.sort_order ASC, g.name ASC, s.name ASC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM app.sections AS s
      WHERE s.school_id = ${schoolId}
        ${yearFilter}
        ${gradeFilter}
    `,
  ]);

  return { rows, total: Number(countResult[0]?.count ?? 0) };
}

export async function getSection(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
): Promise<SectionRow | undefined> {
  const [row] = await tx<SectionRow[]>`
    SELECT ${sectionColumns(tx)}
    FROM app.sections AS s
    JOIN app.grade_levels AS g ON g.id = s.grade_level_id AND g.school_id = s.school_id
    WHERE s.id = ${sectionId} AND s.school_id = ${schoolId}
  `;
  return row;
}

async function requireSection(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
): Promise<SectionRow> {
  const section = await getSection(tx, schoolId, sectionId);
  if (!section) {
    throw new HTTPException(404, { message: "Section not found" });
  }
  return section;
}

export async function createSection(
  tx: TransactionSql,
  schoolId: string,
  params: { academic_year_id: string; grade_level_id: string; name: string },
): Promise<SectionRow> {
  const [year] = await tx<{ id: string }[]>`
    SELECT id FROM app.academic_years
    WHERE id = ${params.academic_year_id} AND school_id = ${schoolId}
  `;
  if (!year) {
    throw new HTTPException(404, { message: "Academic year not found" });
  }
  const [grade] = await tx<{ id: string }[]>`
    SELECT id FROM app.grade_levels
    WHERE id = ${params.grade_level_id} AND school_id = ${schoolId}
  `;
  if (!grade) {
    throw new HTTPException(404, { message: "Grade level not found" });
  }

  const [inserted] = await tx<{ id: string }[]>`
    INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
    VALUES (${schoolId}, ${params.academic_year_id}, ${params.grade_level_id}, ${params.name})
    RETURNING id
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "sections",
    targetId: inserted!.id,
    newValues: { ...params },
  });

  return requireSection(tx, schoolId, inserted!.id);
}

export async function updateSection(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  params: { name?: string; archived?: boolean },
): Promise<SectionRow> {
  const updated = await tx`
    UPDATE app.sections
    SET name = COALESCE(${params.name ?? null}, name),
        archived_at = CASE ${params.archived ?? null}::boolean
          WHEN true THEN COALESCE(archived_at, CURRENT_TIMESTAMP)
          WHEN false THEN NULL
          ELSE archived_at
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${sectionId} AND school_id = ${schoolId}
    RETURNING id
  `;
  if (updated.length === 0) {
    throw new HTTPException(404, { message: "Section not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "sections",
    targetId: sectionId,
    newValues: { ...params },
  });

  return requireSection(tx, schoolId, sectionId);
}

export async function deleteSection(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
): Promise<void> {
  const [{ count }] = await tx<{ count: number }[]>`
    SELECT (
      (SELECT count(*) FROM app.classes WHERE section_id = ${sectionId} AND school_id = ${schoolId})
      + (SELECT count(*) FROM app.student_sections
         WHERE section_id = ${sectionId} AND school_id = ${schoolId})
    )::int AS count
  `;
  if (Number(count) > 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SECTION_IN_USE,
      "Move this section's classes and students to another section first.",
    );
  }

  const deleted = await tx`
    DELETE FROM app.sections
    WHERE id = ${sectionId} AND school_id = ${schoolId}
    RETURNING id
  `;
  if (deleted.length === 0) {
    throw new HTTPException(404, { message: "Section not found" });
  }

  await emitAuditLog(tx, { action: "delete", targetTable: "sections", targetId: sectionId });
}

// ---------------------------------------------------------------------------
// Student placement
// ---------------------------------------------------------------------------

const sectionStudentSelect = (tx: TransactionSql) => tx`
  SELECT ss.student_id, ss.section_id, ss.academic_year_id,
         st.first_name, st.last_name, st.admission_number
  FROM app.student_sections AS ss
  JOIN app.students AS st ON st.id = ss.student_id AND st.school_id = ss.school_id
`;

export async function listSectionStudents(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
): Promise<{ rows: SectionStudentRow[]; total: number }> {
  await requireSection(tx, schoolId, sectionId);
  const rows = await tx<SectionStudentRow[]>`
    ${sectionStudentSelect(tx)}
    WHERE ss.section_id = ${sectionId} AND ss.school_id = ${schoolId}
    ORDER BY st.last_name ASC, st.first_name ASC
  `;
  return { rows, total: rows.length };
}

/** The section's classes a student can still be enrolled into (not cancelled or completed). */
async function openSectionClassIds(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM app.classes
    WHERE section_id = ${sectionId} AND school_id = ${schoolId}
      AND status IN ('planned', 'active')
    ORDER BY code ASC
  `;
  return rows.map((row) => row.id);
}

/**
 * Enrolls `studentId` into each of `classIds` they are not already actively enrolled in. A class at
 * capacity is skipped rather than failing the whole placement: the admin sees it in the result and
 * can raise the capacity or enroll by hand.
 */
async function enrollIntoClasses(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  classIds: string[],
): Promise<{ enrolled: string[]; skipped: string[] }> {
  const enrolled: string[] = [];
  const skipped: string[] = [];
  for (const classId of classIds) {
    const [existing] = await tx<{ status: string }[]>`
      SELECT status FROM app.enrollments
      WHERE class_id = ${classId} AND student_id = ${studentId} AND school_id = ${schoolId}
    `;
    if (existing && (existing.status === "active" || existing.status === "waitlisted")) continue;
    // A savepoint, so a capacity rejection leaves the rest of the placement intact.
    try {
      await tx.savepoint((sp) => enrollStudent(sp, schoolId, classId, studentId));
      enrolled.push(classId);
    } catch (error) {
      if (
        error instanceof CodedHttpException &&
        error.code === ERROR_CODES.CLASS_CAPACITY_EXCEEDED
      ) {
        skipped.push(classId);
        continue;
      }
      throw error;
    }
  }
  return { enrolled, skipped };
}

/**
 * Enrolls every student placed in `sectionId` into `classIds` (a class that was just created in,
 * or moved to, the section). Called by the class service.
 */
export async function enrollSectionStudents(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  classIds: string[],
): Promise<void> {
  const open = (await openSectionClassIds(tx, schoolId, sectionId)).filter((id) =>
    classIds.includes(id),
  );
  if (open.length === 0) return;
  const students = await tx<{ student_id: string }[]>`
    SELECT student_id FROM app.student_sections
    WHERE section_id = ${sectionId} AND school_id = ${schoolId}
  `;
  for (const { student_id } of students) {
    await enrollIntoClasses(tx, schoolId, student_id, open);
  }
}

/** Withdraws `studentId` from the active enrollments they hold in `sectionId`'s classes. */
async function withdrawFromSectionClasses(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  studentId: string,
): Promise<void> {
  const active = await tx<{ class_id: string }[]>`
    SELECT e.class_id
    FROM app.enrollments AS e
    JOIN app.classes AS cl ON cl.id = e.class_id AND cl.school_id = e.school_id
    WHERE cl.section_id = ${sectionId} AND e.student_id = ${studentId}
      AND e.school_id = ${schoolId} AND e.status IN ('active', 'waitlisted')
  `;
  for (const { class_id } of active) {
    await withdrawStudent(tx, schoolId, class_id, studentId);
  }
}

/**
 * Places a student in a section for its academic year and enrolls them into the section's classes,
 * so the section's timetable becomes theirs. A student already in another section of the same year
 * is moved: withdrawn from the old section's classes, then enrolled into the new one's.
 */
export async function placeStudentInSection(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  studentId: string,
): Promise<PlacementResult> {
  const section = await requireSection(tx, schoolId, sectionId);

  const [student] = await tx<{ id: string }[]>`
    SELECT id FROM app.students WHERE id = ${studentId} AND school_id = ${schoolId}
  `;
  if (!student) {
    throw new HTTPException(404, { message: "Student not found" });
  }

  const [previous] = await tx<{ section_id: string }[]>`
    SELECT section_id FROM app.student_sections
    WHERE student_id = ${studentId} AND academic_year_id = ${section.academic_year_id}
      AND school_id = ${schoolId}
    FOR UPDATE
  `;

  if (previous && previous.section_id !== sectionId) {
    await withdrawFromSectionClasses(tx, schoolId, previous.section_id, studentId);
  }

  await tx`
    INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
    VALUES (${schoolId}, ${studentId}, ${section.academic_year_id}, ${sectionId})
    ON CONFLICT (school_id, student_id, academic_year_id)
    DO UPDATE SET section_id = EXCLUDED.section_id, updated_at = CURRENT_TIMESTAMP
  `;

  const { enrolled, skipped } = await enrollIntoClasses(
    tx,
    schoolId,
    studentId,
    await openSectionClassIds(tx, schoolId, sectionId),
  );

  await emitAuditLog(tx, {
    action: previous ? "update" : "insert",
    targetTable: "student_sections",
    targetId: studentId,
    oldValues: previous ? { section_id: previous.section_id } : undefined,
    newValues: { section_id: sectionId, enrolled_class_ids: enrolled },
  });

  const [placed] = await tx<SectionStudentRow[]>`
    ${sectionStudentSelect(tx)}
    WHERE ss.student_id = ${studentId} AND ss.section_id = ${sectionId}
      AND ss.school_id = ${schoolId}
  `;

  return { student: placed!, enrolled_class_ids: enrolled, skipped_class_ids: skipped };
}

/** Takes a student out of a section and withdraws them from its classes. */
export async function removeStudentFromSection(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  studentId: string,
): Promise<void> {
  const deleted = await tx`
    DELETE FROM app.student_sections
    WHERE section_id = ${sectionId} AND student_id = ${studentId} AND school_id = ${schoolId}
    RETURNING id
  `;
  if (deleted.length === 0) {
    throw new HTTPException(404, { message: "Student is not in this section" });
  }

  await withdrawFromSectionClasses(tx, schoolId, sectionId, studentId);

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "student_sections",
    targetId: studentId,
    oldValues: { section_id: sectionId },
  });
}
