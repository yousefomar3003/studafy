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
