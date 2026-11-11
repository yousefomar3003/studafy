import { requireYear } from "./access";
import { certificateReadinessMany } from "./certificate-service";
import {
  collectPublishIssues,
  listConfigSummaries,
  loadYearConfigContext,
  sectionSubjectsOf,
} from "./config-service";
import { computeLoadedSection, loadSectionsGradingData } from "./results-service";

import type { GradingConfigStatus } from "./access";
import type { PublishIssue } from "./config-service";
import type { TransactionSql } from "postgres";

/**
 * The admin's readiness dashboard for one academic year: what is configured, what is inherited or
 * overridden, what is missing, and how far marks, approvals, finalization and certificates have
 * got. Every figure comes from the same services the actions use, so "ready" here means the action
 * will succeed.
 *
 * Read set-based: the year's configuration, sections, rosters, marks, sheets and certificate state
 * are loaded in a fixed number of queries (about twenty, whatever the size of the school) and the
 * per-section figures are computed in memory with the same functions the per-section actions use.
 */

export interface GradingOverview {
  year: { id: string; code: string; name: string; grading_config_status: GradingConfigStatus };
  grades: {
    grade_level_id: string;
    grade_level_name: string;
    grade_scale_id: string | null;
    mark_approval_required: boolean;
    subjects: {
      config_id: string;
      subject_id: string;
      subject_name: string;
      requirement: "mandatory" | "optional" | "elective";
      valid: boolean;
      error_count: number;
      warning_count: number;
      term_category_total: number;
      annual_total: number;
      revision: number;
    }[];
    sections: {
      section_id: string;
      name: string;
      student_count: number;
      subjects: {
        subject_id: string;
        subject_name: string;
        source: string;
        config_id: string | null;
        outdated: boolean;
        teacher_names: string[];
      }[];
      students_incomplete: number | null;
      annual_finalization_id: string | null;
      term_finalization_ids: string[];
      certificates: {
        ready: number;
        issued: number;
        needs_reissue: number;
        blocked: number;
      } | null;
    }[];
  }[];
  counts: {
    grades: number;
    subjects_invalid: number;
    sections: number;
    sections_with_overrides: number;
    outdated_overrides: number;
    missing_teacher_assignments: number;
    students_with_incomplete_marks: number;
    mark_sheets_awaiting_approval: number;
    proposed_assessments: number;
    certificates_ready: number;
    certificates_blocked: number;
    certificates_needing_reissue: number;
  };
  issues: PublishIssue[];
}

export async function getGradingOverview(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<GradingOverview> {
  const year = await requireYear(tx, schoolId, yearId);
  const context = await loadYearConfigContext(tx, schoolId, yearId);
  const programs = context.programs;
  const configSummaries = await listConfigSummaries(tx, schoolId, yearId, context);
  const issues = await collectPublishIssues(tx, schoolId, yearId, context);

  const [pendingSheets] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.mark_sheets
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid AND status = 'submitted'
  `;
  const [proposed] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.subject_config_assessments
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid AND status = 'proposed'
  `;
  const finalizations = await tx<{ id: string; section_id: string; term_id: string | null }[]>`
    SELECT id, section_id, term_id FROM app.result_finalizations
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid AND status = 'finalized'
  `;

  const counts: GradingOverview["counts"] = {
    grades: programs.length,
    subjects_invalid: configSummaries.filter((config) => !config.valid).length,
    sections: 0,
    sections_with_overrides: 0,
    outdated_overrides: 0,
    missing_teacher_assignments: 0,
    students_with_incomplete_marks: 0,
    mark_sheets_awaiting_approval: pendingSheets?.count ?? 0,
    proposed_assessments: proposed?.count ?? 0,
    certificates_ready: 0,
    certificates_blocked: 0,
    certificates_needing_reissue: 0,
  };

  // Sections listed under a program, and the subjects each one has.
  const programGrades = new Set(programs.map((program) => program.grade_level_id));
  const listed = context.sections
    .filter((section) => programGrades.has(section.grade_level_id))
    .map((section) => ({ section, subjects: sectionSubjectsOf(context, section) }));

  // Incomplete students only mean something once marks can be entered.
  const computed = listed.filter(
    ({ section, subjects }) =>
      year.grading_config_status === "active" && section.student_count > 0 && subjects.length > 0,
  );
  const computedIds = new Set(computed.map(({ section }) => section.id));
  const gradingData =
    computed.length > 0
      ? await loadSectionsGradingData(
          tx,
          schoolId,
          yearId,
          computed.map(({ section }) => section),
          context,
        )
      : null;

  const annualFinalizations = listed.flatMap(({ section }) => {
    const annual = finalizations.find((f) => f.section_id === section.id && f.term_id === null);
    return annual ? [{ ...annual, status: "finalized" as const }] : [];
  });
  const readiness = await certificateReadinessMany(tx, schoolId, annualFinalizations);

  const grades: GradingOverview["grades"] = [];
  for (const program of programs) {
    const sections: GradingOverview["grades"][number]["sections"] = [];
    for (const { section, subjects } of listed.filter(
      (entry) => entry.section.grade_level_id === program.grade_level_id,
    )) {
      counts.sections += 1;
      if (subjects.some((subject) => subject.source !== "inherited"))
        counts.sections_with_overrides += 1;
      counts.outdated_overrides += subjects.filter((subject) => subject.outdated).length;
      counts.missing_teacher_assignments += subjects.filter(
        (subject) => subject.source !== "excluded" && subject.teachers.length === 0,
      ).length;

      let incomplete: number | null = null;
      if (computedIds.has(section.id)) {
        const { student_count: _count, ...sectionRow } = section;
        const computation = computeLoadedSection(gradingData!, sectionRow, null);
        incomplete = computation.students.filter(
          (student) => student.overall.status === "incomplete",
        ).length;
        counts.students_with_incomplete_marks += incomplete;
      }

      const annual = finalizations.find((f) => f.section_id === section.id && f.term_id === null);
      let certificates: {
        ready: number;
        issued: number;
        needs_reissue: number;
        blocked: number;
      } | null = null;
      if (annual) {
        const rows = readiness.get(annual.id) ?? [];
        certificates = {
          ready: rows.filter((row) => row.state === "ready").length,
          issued: rows.filter((row) => row.state === "issued").length,
          needs_reissue: rows.filter((row) => row.state === "needs_reissue").length,
          blocked: rows.filter((row) => row.state === "blocked").length,
        };
        counts.certificates_ready += certificates.ready;
        counts.certificates_blocked += certificates.blocked;
        counts.certificates_needing_reissue += certificates.needs_reissue;
      }

      sections.push({
        section_id: section.id,
        name: section.name,
        student_count: section.student_count,
        subjects: subjects.map((subject) => ({
          subject_id: subject.subject_id,
          subject_name: subject.subject_name,
          source: subject.source,
          config_id: subject.config_id,
          outdated: subject.outdated,
          teacher_names: subject.teachers.map((teacher) => teacher.name),
        })),
        students_incomplete: incomplete,
        annual_finalization_id: annual?.id ?? null,
        term_finalization_ids: finalizations
          .filter((f) => f.section_id === section.id && f.term_id !== null)
          .map((f) => f.id),
        certificates,
      });
    }

    grades.push({
      grade_level_id: program.grade_level_id,
      grade_level_name: program.grade_level_name,
      grade_scale_id: program.grade_scale_id,
      mark_approval_required: program.mark_approval_required,
      subjects: configSummaries
        .filter(
          (config) =>
            config.grade_level_id === program.grade_level_id && config.section_id === null,
        )
        .map(({ grade_level_id: _g, section_id: _s, ...rest }) => rest),
      sections,
    });
  }

  return {
    year: {
      id: year.id,
      code: year.code,
      name: year.name,
      grading_config_status: year.grading_config_status,
    },
    grades,
    counts,
    issues,
  };
}
