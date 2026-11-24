import { ERROR_CODES, SCHOOL_STAFF_ROLES } from "@studafy/constants";
import { calculateSubjectResult } from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { coordinatedSubjects, requireYear } from "./access";
import {
  effectiveSubjects,
  loadConfigDetails,
  loadYearConfigs,
  rosterFrom,
  sectionConfigs,
  toEngineConfig,
  toMarkInputs,
} from "./engine-config";
import { periodsOf } from "./marks-service";
import { loadSectionsGradingData } from "./results-service";

import type { CoordinatedSubject } from "./access";
import type { MarkSheetStatus } from "./marks-service";
import type { TransactionSql } from "postgres";

/**
 * Subject coordinators (000261): leadership assigns a staff member to coordinate a subject for a
 * year, optionally only some grade levels; the coordinator reads every section's marks, predicted
 * grades and subject results for it, read-only. The row access itself is the database's
 * (app.coordinates_section_subject and the policies 000261 widens); this module manages the
 * assignments and builds the coordinator's overview.
 */

export interface SubjectCoordinatorView {
  id: string;
  academic_year_id: string;
  subject_id: string;
  subject_code: string;
  subject_name: string;
  user_id: string;
  user_name: string;
  grade_levels: { id: string; name: string }[];
  created_at: string;
  updated_at: string;
}

interface CoordinatorRow extends Omit<
  SubjectCoordinatorView,
  "grade_levels" | "created_at" | "updated_at"
> {
  grade_levels: { id: string; name: string }[] | null;
  created_at: Date;
  updated_at: Date;
}

function notFound(message: string): never {
  throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, message);
}

async function loadCoordinators(
  tx: TransactionSql,
  schoolId: string,
  filter: { yearId: string } | { coordinatorId: string },
): Promise<SubjectCoordinatorView[]> {
  const where =
    "yearId" in filter
      ? tx`coordinator.academic_year_id = ${filter.yearId}::uuid`
      : tx`coordinator.id = ${filter.coordinatorId}::uuid`;
  const rows = await tx<CoordinatorRow[]>`
    SELECT coordinator.id, coordinator.academic_year_id, coordinator.subject_id,
           subject.code AS subject_code, subject.name AS subject_name, coordinator.user_id,
           users.display_name AS user_name, coordinator.created_at, coordinator.updated_at,
           (
             SELECT json_agg(json_build_object('id', grade.id, 'name', grade.name)
                             ORDER BY grade.sort_order, grade.name)
             FROM app.subject_coordinator_grade_levels AS covered
             JOIN app.grade_levels AS grade
               ON grade.id = covered.grade_level_id AND grade.school_id = covered.school_id
             WHERE covered.coordinator_id = coordinator.id
               AND covered.school_id = coordinator.school_id
           ) AS grade_levels
    FROM app.subject_coordinators AS coordinator
    JOIN app.subjects AS subject
      ON subject.id = coordinator.subject_id AND subject.school_id = coordinator.school_id
    JOIN app.users AS users
      ON users.id = coordinator.user_id AND users.school_id = coordinator.school_id
    WHERE coordinator.school_id = ${schoolId}::uuid AND ${where}
    ORDER BY subject.name, users.display_name, coordinator.id
  `;
  return rows.map((row) => ({
    ...row,
    grade_levels: row.grade_levels ?? [],
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
}

async function requireCoordinator(
  tx: TransactionSql,
  schoolId: string,
  coordinatorId: string,
): Promise<SubjectCoordinatorView> {
  const [coordinator] = await loadCoordinators(tx, schoolId, { coordinatorId });
  return coordinator ?? notFound("Subject coordinator not found");
}

/** Every coordinator assignment of a year, by subject then person. */
export async function listSubjectCoordinators(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<SubjectCoordinatorView[]> {
  await requireYear(tx, schoolId, yearId);
  return loadCoordinators(tx, schoolId, { yearId });
}

/** The distinct grade levels, each checked to be the school's. */
async function requireGradeLevels(
  tx: TransactionSql,
  schoolId: string,
  gradeLevelIds: readonly string[],
): Promise<string[]> {
  const ids = [...new Set(gradeLevelIds)];
  if (ids.length === 0) return ids;
  const found = await tx<{ id: string }[]>`
    SELECT id FROM app.grade_levels
    WHERE school_id = ${schoolId}::uuid AND id = ANY (${ids}::uuid[])
  `;
  if (found.length !== ids.length) notFound("Grade level not found");
  return ids;
}

async function replaceGradeLevels(
  tx: TransactionSql,
  schoolId: string,
  coordinatorId: string,
  gradeLevelIds: readonly string[],
): Promise<void> {
  await tx`
    DELETE FROM app.subject_coordinator_grade_levels
    WHERE school_id = ${schoolId}::uuid AND coordinator_id = ${coordinatorId}::uuid
  `;
  if (gradeLevelIds.length === 0) return;
  await tx`
    INSERT INTO app.subject_coordinator_grade_levels (school_id, coordinator_id, grade_level_id)
    SELECT ${schoolId}::uuid, ${coordinatorId}::uuid, grade_level_id
    FROM unnest(${gradeLevelIds as string[]}::uuid[]) AS grade_level_id
  `;
}

export interface SubjectCoordinatorInput {
  subject_id: string;
  user_id: string;
  grade_level_ids: string[];
}

export async function createSubjectCoordinator(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  input: SubjectCoordinatorInput,
): Promise<SubjectCoordinatorView> {
  await requireYear(tx, schoolId, yearId);
  const [subject] = await tx<{ id: string }[]>`
    SELECT id FROM app.subjects
    WHERE id = ${input.subject_id}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!subject) notFound("Subject not found");
  const [user] = await tx<{ staff: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM app.user_roles AS role
      WHERE role.school_id = users.school_id AND role.user_id = users.id
        AND role.role::text = ANY (${[...SCHOOL_STAFF_ROLES]}::text[])
    ) AS staff
    FROM app.users AS users
    WHERE users.id = ${input.user_id}::uuid AND users.school_id = ${schoolId}::uuid
  `;
  if (!user) notFound("User not found");
  if (!user.staff) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "A subject coordinator must be a member of the school's staff",
    );
  }
  const gradeLevelIds = await requireGradeLevels(tx, schoolId, input.grade_level_ids);

  const inserted = await tx<{ id: string }[]>`
    INSERT INTO app.subject_coordinators (school_id, academic_year_id, subject_id, user_id)
    VALUES (${schoolId}::uuid, ${yearId}::uuid, ${input.subject_id}::uuid, ${input.user_id}::uuid)
    ON CONFLICT (school_id, academic_year_id, subject_id, user_id) DO NOTHING
    RETURNING id
  `;
  const id = inserted[0]?.id;
  if (!id) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SUBJECT_COORDINATOR_DUPLICATE,
      "This person already coordinates this subject this year",
    );
  }
  await replaceGradeLevels(tx, schoolId, id, gradeLevelIds);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "subject_coordinators",
    targetId: id,
    newValues: { academic_year_id: yearId, ...input, grade_level_ids: gradeLevelIds },
  });
  return requireCoordinator(tx, schoolId, id);
}

/** Change the grade levels an assignment covers (empty: every grade taught the subject). */
export async function updateSubjectCoordinator(
  tx: TransactionSql,
  schoolId: string,
  coordinatorId: string,
  input: { grade_level_ids: string[] },
): Promise<SubjectCoordinatorView> {
  const before = await requireCoordinator(tx, schoolId, coordinatorId);
  const gradeLevelIds = await requireGradeLevels(tx, schoolId, input.grade_level_ids);
  await replaceGradeLevels(tx, schoolId, coordinatorId, gradeLevelIds);
  await tx`
    UPDATE app.subject_coordinators SET updated_at = CURRENT_TIMESTAMP
    WHERE id = ${coordinatorId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "subject_coordinators",
    targetId: coordinatorId,
    oldValues: { grade_level_ids: before.grade_levels.map((grade) => grade.id) },
    newValues: { grade_level_ids: gradeLevelIds },
  });
  return requireCoordinator(tx, schoolId, coordinatorId);
}

export async function deleteSubjectCoordinator(
  tx: TransactionSql,
  schoolId: string,
  coordinatorId: string,
): Promise<void> {
  const before = await requireCoordinator(tx, schoolId, coordinatorId);
  // The grade levels go with it (ON DELETE CASCADE).
  await tx`
    DELETE FROM app.subject_coordinators
    WHERE id = ${coordinatorId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "subject_coordinators",
    targetId: coordinatorId,
    oldValues: {
      academic_year_id: before.academic_year_id,
      subject_id: before.subject_id,
      user_id: before.user_id,
      grade_level_ids: before.grade_levels.map((grade) => grade.id),
    },
  });
}

// ---------------------------------------------------------------------------
// The coordinator's overview
// ---------------------------------------------------------------------------

export interface CoordinatedSectionView {
  section_id: string;
  section_name: string;
  grade_level_id: string;
  grade_level_name: string;
  teacher_names: string[];
  student_count: number;
  average_percentage: number | null;
  complete_count: number;
  sheets: { term_id: string | null; term_name: string | null; status: MarkSheetStatus }[];
  results: {
    term_id: string | null;
    term_name: string | null;
    average_percentage: number | null;
    student_count: number;
    finalized_at: string;
  }[];
}

export interface MyCoordinatedSubjectsView {
  academic_year_id: string | null;
  subjects: (CoordinatedSubject & { sections: CoordinatedSectionView[] })[];
}

interface CoordinatedSectionRow {
  id: string;
  name: string;
  academic_year_id: string;
  grade_level_id: string;
  grade_level_name: string;
  archived_at: Date | null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** The year asked for, or the latest active or finalized one (as the teacher's own list does). */
async function resolveYearId(
  tx: TransactionSql,
  schoolId: string,
  yearId: string | undefined,
): Promise<string | null> {
  if (yearId) return (await requireYear(tx, schoolId, yearId)).id;
  const [latest] = await tx<{ id: string }[]>`
    SELECT id FROM app.academic_years
    WHERE school_id = ${schoolId}::uuid AND grading_config_status IN ('active', 'finalized')
    ORDER BY starts_on DESC LIMIT 1
  `;
  return latest?.id ?? null;
}

/** One coordinated subject across the sections it covers. */
async function coordinatedSections(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  subject: CoordinatedSubject,
): Promise<CoordinatedSectionView[]> {
  const gradeFilter =
    subject.grade_level_ids.length > 0
      ? tx`AND section.grade_level_id = ANY (${subject.grade_level_ids}::uuid[])`
      : tx``;
  const candidates = await tx<CoordinatedSectionRow[]>`
    SELECT section.id, section.name, section.academic_year_id, section.grade_level_id,
           grade.name AS grade_level_name, section.archived_at
    FROM app.sections AS section
    JOIN app.grade_levels AS grade
      ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    WHERE section.school_id = ${schoolId}::uuid AND section.academic_year_id = ${yearId}::uuid
      ${gradeFilter}
    ORDER BY grade.sort_order, grade.name, section.name, section.id
  `;
  if (candidates.length === 0) return [];

  // Only this subject's configs: the other subjects of these grades are none of the coordinator's.
  const configs = (
    await loadYearConfigs(tx, schoolId, yearId, {
      gradeLevelIds: [...new Set(candidates.map((section) => section.grade_level_id))],
      sectionIds: candidates.map((section) => section.id),
    })
  ).filter((config) => config.subject_id === subject.subject_id);
  const taught = candidates
    .map((section) => ({
      section,
      effective: effectiveSubjects(sectionConfigs(configs, section)).find(
        (candidate) => candidate.subject_id === subject.subject_id && candidate.config_id !== null,
      ),
    }))
    .filter((entry) => entry.effective !== undefined);
  if (taught.length === 0) return [];

  const details = await loadConfigDetails(tx, schoolId, yearId, configs);
  const data = await loadSectionsGradingData(
    tx,
    schoolId,
    yearId,
    taught.map((entry) => entry.section),
    { configs, details },
  );
  const sectionIds = taught.map((entry) => entry.section.id);
  const termName = (termId: string | null) =>
    termId === null ? null : (details.terms.find((term) => term.id === termId)?.name ?? null);

  const [teachers, results] = await Promise.all([
    tx<{ section_id: string; name: string }[]>`
      SELECT DISTINCT assignment.section_id, users.display_name AS name
      FROM app.section_subject_teachers AS assignment
      JOIN app.teachers AS teacher
        ON teacher.id = assignment.teacher_id AND teacher.school_id = assignment.school_id
      JOIN app.users AS users ON users.id = teacher.user_id AND users.school_id = teacher.school_id
      WHERE assignment.school_id = ${schoolId}::uuid
        AND assignment.subject_id = ${subject.subject_id}::uuid
        AND assignment.section_id = ANY (${sectionIds}::uuid[])
      ORDER BY users.display_name
    `,
    // RLS (app.coordinates_result_subject) returns this subject's rows of the current versions.
    tx<
      {
        section_id: string;
        term_id: string | null;
        finalized_at: Date;
        average: string | null;
        complete: string;
      }[]
    >`
      SELECT finalization.section_id, finalization.term_id, finalization.finalized_at,
             avg(result.percentage) FILTER (WHERE result.status = 'complete') AS average,
             count(*) FILTER (WHERE result.status = 'complete') AS complete
      FROM app.result_finalizations AS finalization
      JOIN app.student_subject_results AS result
        ON result.finalization_id = finalization.id AND result.school_id = finalization.school_id
      WHERE finalization.school_id = ${schoolId}::uuid
        AND finalization.status = 'finalized'
        AND finalization.section_id = ANY (${sectionIds}::uuid[])
        AND result.subject_id = ${subject.subject_id}::uuid
      GROUP BY finalization.id, finalization.section_id, finalization.term_id,
               finalization.finalized_at
    `,
  ]);
  const termOrder = (termId: string | null) =>
    termId === null
      ? Number.MAX_SAFE_INTEGER
      : (details.terms.find((term) => term.id === termId)?.sequence_number ?? 0);

  return taught.map(({ section, effective }) => {
    const engine = toEngineConfig(details.get(effective!.config_id!), { sectionId: section.id });
    const roster = rosterFrom(
      data.placements.get(section.id) ?? [],
      data.choices,
      subject.subject_id,
      effective!.requirement,
    ).filter((student) => student.status === "enrolled");
    const assessmentIds = new Set(engine.assessments.map((assessment) => assessment.id));
    const percentages: number[] = [];
    let complete = 0;
    for (const student of roster) {
      const marks = (data.marksByStudent.get(student.student_id) ?? []).filter((mark) =>
        assessmentIds.has(mark.assessment_id),
      );
      const result = calculateSubjectResult(engine, toMarkInputs(marks, student.student_id));
      if (result.status === "complete") complete += 1;
      const value = result.percentage ?? result.provisionalPercentage;
      if (value !== null) percentages.push(value);
    }
    const sheets = (data.sheets.get(section.id) ?? []).filter(
      (sheet) => sheet.subject_id === subject.subject_id,
    );
    return {
      section_id: section.id,
      section_name: section.name,
      grade_level_id: section.grade_level_id,
      grade_level_name: section.grade_level_name,
      teacher_names: teachers.filter((row) => row.section_id === section.id).map((row) => row.name),
      student_count: roster.length,
      average_percentage:
        percentages.length === 0
          ? null
          : round2(percentages.reduce((sum, value) => sum + value, 0) / percentages.length),
      complete_count: complete,
      sheets: periodsOf(engine).map((termId) => ({
        term_id: termId,
        term_name: termName(termId),
        status: (sheets.find((sheet) => sheet.term_id === termId)?.status ??
          "draft") as MarkSheetStatus,
      })),
      results: results
        .filter((row) => row.section_id === section.id)
        .sort((a, b) => termOrder(a.term_id) - termOrder(b.term_id))
        .map((row) => ({
          term_id: row.term_id,
          term_name: termName(row.term_id),
          average_percentage: row.average === null ? null : round2(Number(row.average)),
          student_count: Number(row.complete),
          finalized_at: row.finalized_at.toISOString(),
        })),
    };
  });
}

/**
 * The current user's coordinated subjects for a year (or the latest active or finalized year): each
 * subject's sections with their teachers, mark sheet status per period, the current average from
 * the marks recorded so far, and the averages of finalized results. Empty for anyone who
 * coordinates nothing.
 */
export async function getMyCoordinatedSubjects(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  yearId: string | undefined,
): Promise<MyCoordinatedSubjectsView> {
  const resolved = await resolveYearId(tx, schoolId, yearId);
  if (!resolved) return { academic_year_id: null, subjects: [] };
  const subjects = await coordinatedSubjects(tx, userId, resolved);
  const views: MyCoordinatedSubjectsView["subjects"] = [];
  for (const subject of subjects) {
    views.push({
      ...subject,
      sections: await coordinatedSections(tx, schoolId, resolved, subject),
    });
  }
  return { academic_year_id: resolved, subjects: views };
}
