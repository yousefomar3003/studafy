import { calculateSubjectResult } from "@studafy/grading-engine";

import { assertCanGradeSectionSubject } from "./access";
import {
  loadConfigDetail,
  loadMarks,
  loadRoster,
  requireEffectiveSubject,
  requireProgram,
  requireSectionRow,
  toEngineConfig,
  toMarkInputs,
} from "./engine-config";

import type { MarkStatus, ResultFormatKind } from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

/**
 * One student's live result in one subject of their section, for the teacher's student page.
 *
 * The same computation the mark sheet's preview runs (`getMarkSheet` in marks-service.ts): the
 * effective subject configuration for the section, the student's marks on the assessments that
 * apply to the section, and the grading engine. Nothing is stored. Access is the mark sheet's: a
 * teacher of the subject in the section (or school leadership); raw marks stay staff data.
 *
 * The result is also shown in the grade's chosen result format (#411): a percentage, a mark out of
 * the grade's maximum (16.5 out of 20), or the subject's GPA points from the grade scale.
 */
export interface StudentSubjectMarks {
  grading_method: "weighted" | "total_points" | "descriptive";
  result_format: ResultFormatKind;
  /** 100 for percentage; the grade's out-of or GPA maximum otherwise. */
  result_scale_max: number;
  /** The student is exempt from the subject: no result, no marks expected. */
  exempt: boolean;
  status: "complete" | "incomplete";
  /** Final rounded percentage; null until every required mark is in. */
  percentage: number | null;
  /** Percentage over what has been marked so far, for an incomplete result. */
  provisional_percentage: number | null;
  /** The result in the grade's format; provisional while `status` is incomplete. */
  display_value: number | null;
  grade_label: string | null;
  passed: boolean | null;
  /** This term's percentage within the subject, when the subject has marks in it. */
  term_percentage: number | null;
  assessments: {
    id: string;
    name: string;
    term_id: string | null;
    max_marks: number;
    assessment_date: string | null;
    /** `pending`: no mark yet. */
    status: MarkStatus | "pending";
    score: number | null;
    /** A descriptive subject's mark: the descriptor's label instead of a score. */
    descriptor_label: string | null;
  }[];
}

/** The reason a student page has no marks section instead of a result. */
export type StudentMarksUnavailable = "not_configured" | "not_in_roster";

const round2 = (value: number) => Math.round(value * 100) / 100;

export async function getStudentSubjectMarks(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
  studentId: string,
  termId: string | null,
): Promise<StudentSubjectMarks | StudentMarksUnavailable> {
  const section = await requireSectionRow(tx, schoolId, sectionId);
  await assertCanGradeSectionSubject(tx, sectionId, subjectId);

  let subject;
  try {
    subject = await requireEffectiveSubject(tx, schoolId, section, subjectId);
  } catch {
    return "not_configured";
  }
  const loaded = await loadConfigDetail(tx, schoolId, subject.config_id);
  const roster = await loadRoster(tx, schoolId, section, subjectId, subject.requirement);
  const student = roster.find((row) => row.student_id === studentId);
  if (!student) return "not_in_roster";

  let program;
  try {
    program = await requireProgram(tx, schoolId, section.academic_year_id, section.grade_level_id);
  } catch {
    return "not_configured";
  }
  const format = program.result_format;
  const scaleMax = format === "percentage" ? 100 : Number(program.result_scale_max ?? 100);

  const engine = toEngineConfig(loaded, { sectionId });
  const visible = loaded.assessments.filter(
    (assessment) =>
      assessment.status === "active" &&
      (assessment.section_id === null || assessment.section_id === sectionId),
  );
  const marks = await loadMarks(
    tx,
    schoolId,
    visible.map((assessment) => assessment.id),
    [studentId],
  );
  const descriptorLabels = new Map(loaded.descriptors.map((d) => [d.id, d.label]));
  const assessments = visible
    .slice()
    .sort((a, b) =>
      (a.assessment_date ?? a.due_date ?? "9999").localeCompare(
        b.assessment_date ?? b.due_date ?? "9999",
      ),
    )
    .map((assessment) => {
      // The retake (attempt 2) is the one that counts when there is one.
      const own = marks
        .filter((mark) => mark.assessment_id === assessment.id)
        .sort((a, b) => b.attempt - a.attempt)[0];
      return {
        id: assessment.id,
        name: assessment.name,
        term_id: assessment.term_id,
        max_marks: Number(assessment.max_marks),
        assessment_date: assessment.assessment_date,
        status: own?.status ?? ("pending" as const),
        score: own?.score === null || own?.score === undefined ? null : Number(own.score),
        descriptor_label: own?.descriptor_id
          ? (descriptorLabels.get(own.descriptor_id) ?? null)
          : null,
      };
    });

  const base = {
    grading_method: loaded.config.grading_method,
    result_format: format,
    result_scale_max: scaleMax,
    assessments,
  };

  if (student.status === "exempt") {
    return {
      ...base,
      exempt: true,
      status: "incomplete",
      percentage: null,
      provisional_percentage: null,
      display_value: null,
      grade_label: null,
      passed: null,
      term_percentage: null,
    };
  }

  const engineIds = new Set(engine.assessments.map((assessment) => assessment.id));
  const counted = marks.filter((mark) => engineIds.has(mark.assessment_id));
  const result = calculateSubjectResult(engine, toMarkInputs(counted, studentId));
  const provisional =
    result.provisionalPercentage === null ? null : round2(result.provisionalPercentage);
  const shown = result.percentage ?? provisional;
  const term = termId === null ? undefined : result.terms.find((t) => t.termId === termId);

  let displayValue: number | null;
  if (result.descriptive) displayValue = null;
  else if (format === "percentage") displayValue = shown;
  else if (format === "out_of")
    displayValue = shown === null ? null : round2((shown * scaleMax) / 100);
  else displayValue = result.gpaPoints;

  return {
    ...base,
    exempt: false,
    status: result.status,
    percentage: result.percentage,
    provisional_percentage: provisional,
    display_value: displayValue,
    grade_label: result.gradeLabel ?? result.descriptor?.label ?? null,
    passed: result.passed,
    term_percentage: term
      ? (term.percentage ??
        (term.provisionalPercentage === null ? null : round2(term.provisionalPercentage)))
      : null,
  };
}
