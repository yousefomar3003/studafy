/**
 * A frozen copy of the grading read paths as they were before they became set-based (one query
 * per section, subject and config). Tests only: the characterization tests run this and the live
 * code against the same database and require identical output, so the query rewrite cannot change
 * a single grade, issue or count. Do not "fix" or optimize this file — it is the reference.
 */

import { ERROR_CODES } from "@studafy/constants";
import {
  calculateOverallResult,
  calculateSubjectResult,
  hasErrors,
  summarizeWeights,
  validateSubjectConfig,
} from "@studafy/grading-engine";

import { CodedHttpException } from "../../../coded-http-exception";
import { requireYear } from "../access";
import { blockingReasons } from "../certificate-service";
import { listPrograms, listSectionSubjects } from "../config-service";
import {
  buildSnapshot,
  loadConfigDetail,
  loadMarks,
  loadRoster,
  loadScale,
  requireProgram,
  requireSectionRow,
  resolveSectionSubjects,
  toEngineConfig,
  toMarkInputs,
} from "../engine-config";
import { readFinalizationResults, requireFinalization } from "../results-service";

import type { CertificateState, ReadinessRow } from "../certificate-service";
import type { ConfigSummary, PublishIssue } from "../config-service";
import type { RosterStudent } from "../engine-config";
import type { MyAssignment } from "../marks-service";
import type { GradingOverview } from "../overview-service";
import type { SectionComputation, StudentSubjectComputation } from "../results-service";
import type { OverallResult, SubjectOutcomeForOverall } from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

function overallFor(subjects: StudentSubjectComputation[]): OverallResult {
  const outcomes: SubjectOutcomeForOverall[] = subjects.map((subject) => ({
    subjectId: subject.subject_id,
    requirement: subject.snapshot.requirement,
    includeInAverage: subject.snapshot.include_in_average,
    averageWeight: subject.snapshot.average_weight,
    exempt: subject.exempt,
    result: subject.result,
  }));
  const first = subjects[0]?.snapshot.program;
  return calculateOverallResult(outcomes, {
    rounding: first?.rounding ?? { decimals: 2, mode: "half_up" },
    maxFailedSubjectsForSupplementary: first?.max_failed_subjects_for_supplementary ?? 0,
    scale: first?.scale ?? null,
  });
}

export async function legacyComputeSection(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  termId: string | null,
): Promise<SectionComputation> {
  const section = await requireSectionRow(tx, schoolId, sectionId);
  if (termId !== null) {
    const [term] = await tx<{ id: string }[]>`
      SELECT id FROM app.terms
      WHERE id = ${termId}::uuid AND school_id = ${schoolId}::uuid
        AND academic_year_id = ${section.academic_year_id}::uuid
    `;
    if (!term)
      throw new CodedHttpException(
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        "Term not found in this year",
      );
  }
  const program = await requireProgram(
    tx,
    schoolId,
    section.academic_year_id,
    section.grade_level_id,
  );
  const programScale = (await loadScale(tx, schoolId, program.grade_scale_id)).bands;
  const subjects = (await resolveSectionSubjects(tx, schoolId, section)).filter(
    (subject) => subject.config_id !== null,
  );

  const placed = await tx<
    { id: string; first_name: string; last_name: string; admission_number: string }[]
  >`
    SELECT student.id, student.first_name, student.last_name, student.admission_number
    FROM app.student_sections AS placement
    JOIN app.students AS student ON student.id = placement.student_id AND student.school_id = placement.school_id
    WHERE placement.school_id = ${schoolId}::uuid AND placement.section_id = ${sectionId}::uuid
    ORDER BY student.last_name, student.first_name, student.id
  `;
  const perStudent = new Map<string, StudentSubjectComputation[]>(placed.map((s) => [s.id, []]));
  const unapproved: string[] = [];
  const sheets = await tx<{ subject_id: string; term_id: string | null; status: string }[]>`
    SELECT subject_id, term_id, status FROM app.mark_sheets
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
  `;
  const terms = await tx<{ id: string; name: string }[]>`
    SELECT id, name FROM app.terms WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${section.academic_year_id}::uuid
  `;

  for (const subject of subjects) {
    const loaded = await loadConfigDetail(tx, schoolId, subject.config_id!);
    const engine = toEngineConfig(loaded, { sectionId });
    if (termId !== null && !engine.assessments.some((assessment) => assessment.termId === termId)) {
      continue;
    }
    const snapshot = buildSnapshot(loaded, subject.source, engine, program, programScale);
    const roster: RosterStudent[] = await loadRoster(
      tx,
      schoolId,
      section,
      subject.subject_id,
      subject.requirement,
    );

    const periods = new Set(
      engine.assessments
        .filter((assessment) =>
          termId === null
            ? engine.method !== "weighted" ||
              assessment.termId === null ||
              (engine.terms.find((term) => term.termId === assessment.termId)?.weight ?? 0) > 0
            : assessment.termId === termId,
        )
        .map((assessment) => assessment.termId),
    );
    for (const period of periods) {
      const sheet = sheets.find((s) => s.subject_id === subject.subject_id && s.term_id === period);
      if (sheet?.status !== "approved") {
        const label =
          period === null ? "annual" : (terms.find((t) => t.id === period)?.name ?? "term");
        unapproved.push(`${subject.subject_name} (${label})`);
      }
    }

    const marks = await loadMarks(
      tx,
      schoolId,
      engine.assessments.map((assessment) => assessment.id),
      roster.map((student) => student.student_id),
    );
    for (const student of roster) {
      const list = perStudent.get(student.student_id);
      if (!list) continue;
      const exempt = student.status === "exempt";
      list.push({
        subject_id: subject.subject_id,
        subject_name: subject.subject_name,
        subject_code: subject.subject_code,
        config_id: subject.config_id!,
        snapshot,
        exempt,
        result: exempt
          ? null
          : calculateSubjectResult(
              engine,
              toMarkInputs(marks, student.student_id),
              termId === null ? {} : { termId },
            ),
      });
    }
  }

  return {
    section,
    term_id: termId,
    unapproved_sheets: program.mark_approval_required ? unapproved : [],
    students: placed.map((student) => {
      const subjectsOfStudent = perStudent.get(student.id) ?? [];
      return {
        student: {
          id: student.id,
          first_name: student.first_name,
          last_name: student.last_name,
          admission_number: student.admission_number,
        },
        subjects: subjectsOfStudent,
        overall: overallFor(subjectsOfStudent),
      };
    }),
  };
}

export async function legacyListConfigSummaries(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<ConfigSummary[]> {
  const rows = await tx<{ id: string; is_excluded: boolean }[]>`
    SELECT config.id, config.is_excluded
    FROM app.subject_configs AS config
    JOIN app.subjects AS subject ON subject.id = config.subject_id AND subject.school_id = config.school_id
    WHERE config.school_id = ${schoolId}::uuid AND config.academic_year_id = ${yearId}::uuid
    ORDER BY subject.name
  `;
  const summaries: ConfigSummary[] = [];
  for (const row of rows) {
    if (row.is_excluded) continue;
    const loaded = await loadConfigDetail(tx, schoolId, row.id);
    const engine = toEngineConfig(loaded);
    const issues = validateSubjectConfig(engine);
    const weights = summarizeWeights(engine);
    summaries.push({
      config_id: row.id,
      grade_level_id: loaded.config.grade_level_id,
      section_id: loaded.config.section_id,
      subject_id: loaded.config.subject_id,
      subject_name: loaded.config.subject_name,
      requirement: loaded.config.requirement,
      valid: !hasErrors(issues),
      error_count: issues.filter((issue) => issue.severity === "error").length,
      warning_count: issues.filter((issue) => issue.severity === "warning").length,
      term_category_total: weights.termCategoryTotal,
      annual_total: weights.annualTotal,
      revision: loaded.config.revision,
    });
  }
  return summaries;
}

export async function legacyCollectPublishIssues(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<PublishIssue[]> {
  const issues: PublishIssue[] = [];
  const programs = await listPrograms(tx, schoolId, yearId);
  if (programs.length === 0) {
    issues.push({
      severity: "error",
      code: "NO_GRADES",
      message: "No grade is set up for this academic year.",
    });
  }
  const configs = await tx<{ id: string; is_excluded: boolean }[]>`
    SELECT id, is_excluded FROM app.subject_configs
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
  `;
  for (const row of configs) {
    if (row.is_excluded) continue;
    const loaded = await loadConfigDetail(tx, schoolId, row.id);
    for (const issue of validateSubjectConfig(toEngineConfig(loaded))) {
      issues.push({
        severity: issue.severity,
        code: issue.code,
        message: `${loaded.config.subject_name}: ${issue.message}`,
        grade_level_id: loaded.config.grade_level_id,
        section_id: loaded.config.section_id ?? undefined,
        subject_id: loaded.config.subject_id,
        config_id: loaded.config.id,
      });
    }
  }
  for (const program of programs) {
    const sections = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM app.sections
      WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
        AND grade_level_id = ${program.grade_level_id}::uuid
      ORDER BY name
    `;
    const hasSubjects =
      configs.length > 0 &&
      (
        await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.subject_configs
      WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
        AND grade_level_id = ${program.grade_level_id}::uuid
    `
      )[0]!.count > 0;
    if (!hasSubjects) {
      issues.push({
        severity: "error",
        code: "GRADE_WITHOUT_SUBJECTS",
        message: `${program.grade_level_name} has no subjects.`,
        grade_level_id: program.grade_level_id,
      });
    }
    if (sections.length === 0) {
      issues.push({
        severity: "warning",
        code: "GRADE_WITHOUT_SECTIONS",
        message: `${program.grade_level_name} has no sections yet.`,
        grade_level_id: program.grade_level_id,
      });
    }
    for (const section of sections) {
      const { subjects } = await listSectionSubjects(tx, schoolId, section.id);
      for (const subject of subjects) {
        if (subject.source !== "excluded" && subject.teachers.length === 0) {
          issues.push({
            severity: "warning",
            code: "MISSING_TEACHER",
            message: `${program.grade_level_name} ${section.name}: no teacher for ${subject.subject_name}.`,
            grade_level_id: program.grade_level_id,
            section_id: section.id,
            subject_id: subject.subject_id,
          });
        }
        if (subject.outdated) {
          issues.push({
            severity: "warning",
            code: "OVERRIDE_OUTDATED",
            message: `${program.grade_level_name} ${section.name}: the grade default for ${subject.subject_name} changed since this section was customized.`,
            grade_level_id: program.grade_level_id,
            section_id: section.id,
            subject_id: subject.subject_id,
            config_id: subject.override_config_id ?? undefined,
          });
        }
      }
    }
  }
  return issues;
}

export async function legacyCertificateReadiness(
  tx: TransactionSql,
  schoolId: string,
  finalizationId: string,
): Promise<ReadinessRow[]> {
  const finalization = await requireFinalization(tx, schoolId, finalizationId);
  const results = await readFinalizationResults(tx, schoolId, finalizationId);
  const issued = await tx<{ id: string; student_id: string; finalization_id: string }[]>`
    SELECT id, student_id, finalization_id FROM app.certificates
    WHERE school_id = ${schoolId}::uuid AND status = 'issued'
      AND student_id = ANY (${results.map((r) => r.student_id)}::uuid[])
      AND finalization_id IN (
        SELECT id FROM app.result_finalizations
        WHERE school_id = ${schoolId}::uuid AND section_id = ${finalization.section_id}::uuid
          AND term_id IS NOT DISTINCT FROM ${finalization.term_id}::uuid
      )
  `;
  return results.map((result) => {
    const certificate = issued.find((row) => row.student_id === result.student_id);
    const reasons = blockingReasons(result);
    let state: CertificateState;
    if (certificate) {
      state = certificate.finalization_id === finalizationId ? "issued" : "needs_reissue";
    } else {
      state = reasons.length > 0 ? "blocked" : "ready";
    }
    if (finalization.status !== "finalized" && state === "ready") state = "blocked";
    return {
      student_id: result.student_id,
      first_name: result.first_name,
      last_name: result.last_name,
      state,
      reasons:
        finalization.status !== "finalized"
          ? ["These results were superseded by a correction."]
          : state === "blocked"
            ? reasons
            : [],
      certificate_id: certificate?.id ?? null,
    };
  });
}

export async function legacyGetGradingOverview(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<GradingOverview> {
  const year = await requireYear(tx, schoolId, yearId);
  const programs = await listPrograms(tx, schoolId, yearId);
  const configSummaries = await legacyListConfigSummaries(tx, schoolId, yearId);
  const issues = await legacyCollectPublishIssues(tx, schoolId, yearId);

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

  const grades: GradingOverview["grades"] = [];
  for (const program of programs) {
    const sectionRows = await tx<{ id: string; name: string; student_count: number }[]>`
      SELECT section.id, section.name,
             (SELECT count(*)::int FROM app.student_sections AS placement
              WHERE placement.section_id = section.id AND placement.school_id = section.school_id) AS student_count
      FROM app.sections AS section
      WHERE section.school_id = ${schoolId}::uuid AND section.academic_year_id = ${yearId}::uuid
        AND section.grade_level_id = ${program.grade_level_id}::uuid
      ORDER BY section.name
    `;
    const sections: GradingOverview["grades"][number]["sections"] = [];
    for (const section of sectionRows) {
      counts.sections += 1;
      const { subjects } = await listSectionSubjects(tx, schoolId, section.id);
      if (subjects.some((subject) => subject.source !== "inherited"))
        counts.sections_with_overrides += 1;
      counts.outdated_overrides += subjects.filter((subject) => subject.outdated).length;
      counts.missing_teacher_assignments += subjects.filter(
        (subject) => subject.source !== "excluded" && subject.teachers.length === 0,
      ).length;

      let incomplete: number | null = null;
      if (
        year.grading_config_status === "active" &&
        section.student_count > 0 &&
        subjects.length > 0
      ) {
        const computation = await legacyComputeSection(tx, schoolId, section.id, null);
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
        const readiness = await legacyCertificateReadiness(tx, schoolId, annual.id);
        certificates = {
          ready: readiness.filter((row) => row.state === "ready").length,
          issued: readiness.filter((row) => row.state === "issued").length,
          needs_reissue: readiness.filter((row) => row.state === "needs_reissue").length,
          blocked: readiness.filter((row) => row.state === "blocked").length,
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

export async function legacyListMyAssignments(
  tx: TransactionSql,
  schoolId: string,
  yearId: string | undefined,
): Promise<MyAssignment[]> {
  const years = yearId
    ? [yearId]
    : (
        await tx<{ id: string }[]>`
          SELECT id FROM app.academic_years
          WHERE school_id = ${schoolId}::uuid AND grading_config_status IN ('active', 'finalized')
          ORDER BY starts_on DESC LIMIT 1
        `
      ).map((row) => row.id);
  if (years.length === 0) return [];

  const candidates = await tx<{ section_id: string; subject_id: string }[]>`
    SELECT DISTINCT section.id AS section_id, config.subject_id
    FROM app.sections AS section
    JOIN app.subject_configs AS config
      ON config.school_id = section.school_id AND config.academic_year_id = section.academic_year_id
     AND config.grade_level_id = section.grade_level_id
     AND (config.section_id IS NULL OR config.section_id = section.id)
    WHERE section.school_id = ${schoolId}::uuid AND section.academic_year_id = ${years[0]!}::uuid
      AND app.teaches_section_subject(section.id, config.subject_id)
  `;
  const result: MyAssignment[] = [];
  for (const candidate of candidates) {
    const section = await requireSectionRow(tx, schoolId, candidate.section_id);
    const subjects = await resolveSectionSubjects(tx, schoolId, section);
    const subject = subjects.find((s) => s.subject_id === candidate.subject_id);
    if (!subject || subject.config_id === null) continue;
    const sheets = await tx<
      { term_id: string | null; status: MyAssignment["sheets"][number]["status"] }[]
    >`
      SELECT term_id, status FROM app.mark_sheets
      WHERE school_id = ${schoolId}::uuid AND section_id = ${section.id}::uuid AND subject_id = ${subject.subject_id}::uuid
    `;
    result.push({
      academic_year_id: section.academic_year_id,
      section_id: section.id,
      section_name: section.name,
      grade_level_name: section.grade_level_name,
      subject_id: subject.subject_id,
      subject_name: subject.subject_name,
      config_id: subject.config_id,
      sheets: sheets.map((sheet) => ({ term_id: sheet.term_id, status: sheet.status })),
    });
  }
  return result.sort(
    (a, b) =>
      a.grade_level_name.localeCompare(b.grade_level_name) ||
      a.section_name.localeCompare(b.section_name) ||
      a.subject_name.localeCompare(b.subject_name),
  );
}
