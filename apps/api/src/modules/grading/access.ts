import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";

import type { TransactionSql } from "postgres";

/**
 * Row-level authorization for the grading module.
 *
 * Route middleware already checked the caller's role permission (academicConfig:manage,
 * grade:update, result:finalize...). These checks add the row scope a role cannot express: which
 * section and subject a teacher actually teaches. They call the same SECURITY DEFINER helpers the
 * RLS policies use (000037, 000160), so the API and the database agree on who is who.
 */

export type GradingConfigStatus = "draft" | "active" | "finalized" | "archived";

export interface YearRow {
  id: string;
  code: string;
  name: string;
  starts_on: Date;
  ends_on: Date;
  grading_config_status: GradingConfigStatus;
}

export async function isSchoolLeadership(tx: TransactionSql): Promise<boolean> {
  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT app.current_user_is_school_admin() AS allowed
  `;
  return row?.allowed === true;
}

/** School leadership, or a teacher of `subjectId` in `sectionId`. */
export async function assertCanGradeSectionSubject(
  tx: TransactionSql,
  sectionId: string,
  subjectId: string,
): Promise<{ leadership: boolean }> {
  const [row] = await tx<{ leadership: boolean; teaches: boolean }[]>`
    SELECT app.current_user_is_school_admin() AS leadership,
           app.teaches_section_subject(${sectionId}::uuid, ${subjectId}::uuid) AS teaches
  `;
  if (!row?.leadership && !row?.teaches) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "You do not teach this subject in this section",
    );
  }
  return { leadership: row.leadership };
}

/** Who is reading a section's subject: leadership, one of its teachers, or its coordinator. */
export type SectionSubjectAccess = "leadership" | "teacher" | "coordinator";

/**
 * Read-only access to a section's subject: everything {@link assertCanGradeSectionSubject} allows,
 * plus the subject's coordinator for the section's grade (000261). Callers that write must keep
 * using {@link assertCanGradeSectionSubject}: a coordinator reads, never writes.
 */
export async function assertCanReadSectionSubject(
  tx: TransactionSql,
  sectionId: string,
  subjectId: string,
): Promise<{ access: SectionSubjectAccess }> {
  const [row] = await tx<{ leadership: boolean; teaches: boolean; coordinates: boolean }[]>`
    SELECT app.current_user_is_school_admin() AS leadership,
           app.teaches_section_subject(${sectionId}::uuid, ${subjectId}::uuid) AS teaches,
           app.coordinates_section_subject(${sectionId}::uuid, ${subjectId}::uuid) AS coordinates
  `;
  if (row?.leadership) return { access: "leadership" };
  if (row?.teaches) return { access: "teacher" };
  if (row?.coordinates) return { access: "coordinator" };
  throw new CodedHttpException(
    403,
    ERROR_CODES.AUTHZ_FORBIDDEN,
    "You neither teach nor coordinate this subject in this section",
  );
}

// ---------------------------------------------------------------------------
// Subject coordinators (000261)
// ---------------------------------------------------------------------------

/** One subject the user coordinates in a year. */
export interface CoordinatedSubject {
  /** The assignment (app.subject_coordinators.id). */
  coordinator_id: string;
  subject_id: string;
  subject_code: string;
  subject_name: string;
  /** The grade levels it is limited to; empty: every grade level taught the subject. */
  grade_level_ids: string[];
}

/**
 * Whether the current user coordinates `subjectId` in `academicYearId`: with `sectionId`, for that
 * section's grade level (app.coordinates_section_subject); without, for any grade level
 * (app.coordinates_subject).
 */
export async function coordinatesSubject(
  tx: TransactionSql,
  subjectId: string,
  academicYearId: string,
  sectionId?: string,
): Promise<boolean> {
  const [row] = sectionId
    ? await tx<{ allowed: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM app.sections
          WHERE id = ${sectionId}::uuid AND academic_year_id = ${academicYearId}::uuid
        ) AND app.coordinates_section_subject(${sectionId}::uuid, ${subjectId}::uuid) AS allowed
      `
    : await tx<{ allowed: boolean }[]>`
        SELECT app.coordinates_subject(${subjectId}::uuid, ${academicYearId}::uuid) AS allowed
      `;
  return row?.allowed === true;
}

/**
 * School leadership, or the subject's coordinator for the year (and, with `sectionId`, for that
 * section's grade level). Throws 403 AUTHZ_FORBIDDEN otherwise. For reviewing and following up a
 * subject's work across sections; writing marks stays with {@link assertCanGradeSectionSubject}.
 */
export async function assertCoordinatesSubject(
  tx: TransactionSql,
  subjectId: string,
  academicYearId: string,
  sectionId?: string,
): Promise<{ leadership: boolean }> {
  if (await isSchoolLeadership(tx)) return { leadership: true };
  if (await coordinatesSubject(tx, subjectId, academicYearId, sectionId)) {
    return { leadership: false };
  }
  throw new CodedHttpException(
    403,
    ERROR_CODES.AUTHZ_FORBIDDEN,
    "You do not coordinate this subject",
  );
}

/**
 * The subjects `userId` coordinates in `academicYearId` in the current school, by subject name.
 * Subjects come back as the caller may read them (app.can_read_subject): the user themself and
 * school leadership always see theirs.
 */
export async function coordinatedSubjects(
  tx: TransactionSql,
  userId: string,
  academicYearId: string,
): Promise<CoordinatedSubject[]> {
  return tx<CoordinatedSubject[]>`
    SELECT coordinator.id AS coordinator_id, coordinator.subject_id,
           subject.code AS subject_code, subject.name AS subject_name,
           COALESCE(
             ARRAY(
               SELECT covered.grade_level_id
               FROM app.subject_coordinator_grade_levels AS covered
               JOIN app.grade_levels AS grade
                 ON grade.id = covered.grade_level_id AND grade.school_id = covered.school_id
               WHERE covered.coordinator_id = coordinator.id
                 AND covered.school_id = coordinator.school_id
               ORDER BY grade.sort_order, grade.name
             ),
             '{}'
           )::text[] AS grade_level_ids
    FROM app.subject_coordinators AS coordinator
    JOIN app.subjects AS subject
      ON subject.id = coordinator.subject_id AND subject.school_id = coordinator.school_id
    WHERE coordinator.school_id = current_setting('app.school_id')::uuid
      AND coordinator.user_id = ${userId}::uuid
      AND coordinator.academic_year_id = ${academicYearId}::uuid
    ORDER BY subject.name, subject.id
  `;
}

export async function requireYear(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<YearRow> {
  const [year] = await tx<YearRow[]>`
    SELECT id, code, name, starts_on, ends_on, grading_config_status
    FROM app.academic_years
    WHERE id = ${yearId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!year) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Academic year not found");
  }
  return year;
}

/** Configuration can change while a year is draft or active; finalized and archived are history. */
export function assertConfigEditable(year: YearRow): void {
  if (year.grading_config_status === "finalized" || year.grading_config_status === "archived") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.ACADEMIC_CONFIG_LOCKED,
      `The ${year.name} grading configuration is ${year.grading_config_status} and can no longer be changed`,
    );
  }
}

/** Marks are entered only against a published (active) configuration. */
export function assertMarksOpen(year: YearRow): void {
  if (year.grading_config_status !== "active") {
    throw new CodedHttpException(
      409,
      year.grading_config_status === "draft"
        ? ERROR_CODES.ACADEMIC_YEAR_NOT_ACTIVE
        : ERROR_CODES.ACADEMIC_CONFIG_LOCKED,
      year.grading_config_status === "draft"
        ? "Publish the year's grading configuration before entering marks"
        : `The ${year.name} grading configuration is ${year.grading_config_status}; marks are read-only`,
    );
  }
}

export function notFound(message: string, code = ERROR_CODES.RESOURCE_NOT_FOUND): never {
  throw new CodedHttpException(404, code, message);
}
