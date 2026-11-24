import { useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

type Schemas = components["schemas"];

export type GradingOverview = Schemas["GradingOverview"];
export type GradingStatus = GradingOverview["year"]["grading_config_status"];
export type GradingPublishIssue = Schemas["GradingPublishIssue"];
export type GradingValidationIssue = Schemas["GradingValidationIssue"];
export type GradeProgram = Schemas["GradeProgram"];
export type GradeProgramBody = Schemas["GradeProgramBody"];
export type GradeScale = Schemas["GradeScale"];
export type GradeScaleBody = Schemas["GradeScaleBody"];
export type SubjectConfig = Schemas["SubjectConfig"];
export type CreateSubjectConfigBody = Schemas["CreateSubjectConfigBody"];
export type UpdateSubjectConfigBody = Schemas["UpdateSubjectConfigBody"];
export type SaveSubjectConfigResult = Schemas["SaveSubjectConfigResult"];
export type SubjectConfigImpact = Schemas["SubjectConfigImpact"];
export type SectionGradingSubjects = Schemas["SectionGradingSubjects"];
export type SectionGradingSubject = SectionGradingSubjects["subjects"][number];
export type SubjectSource = SectionGradingSubject["source"];
export type SubjectEnrollment = Schemas["SubjectEnrollmentList"]["enrollments"][number];
export type MarkSheetSummary = Schemas["MarkSheetList"]["sheets"][number];
export type ProposedAssessment = Schemas["ProposedAssessmentList"]["assessments"][number];
export type MarkSheet = Schemas["MarkSheet"];
export type AssessmentReleaseSummary = Schemas["AssessmentReleaseList"]["releases"][number];
export type ResultPreview = Schemas["ResultPreview"];
export type ResultFinalization = Schemas["ResultFinalization"];
export type ExamTemplate = Schemas["ExamTemplate"];
export type ResultFinalizationSummary = Schemas["ResultFinalizationList"]["finalizations"][number];
export type ResultFinalizationDetail = Schemas["ResultFinalizationDetail"];
export type CertificateReadiness = Schemas["CertificateReadiness"];
export type CertificateReadinessStudent = CertificateReadiness["students"][number];
export type AcademicCertificate = Schemas["AcademicCertificate"];
export type CertificateContent = Schemas["CertificateContent"];
export type CopyGradingYearSummary = Schemas["CopyGradingYearSummary"];
export type CurriculumTemplate = Schemas["CurriculumTemplate"];
export type CurriculumTemplatePlan = Schemas["CurriculumTemplatePlan"];
export type CurriculumTemplateLocale = Schemas["CurriculumTemplateLocale"];
export type ClassRank = Schemas["ClassRank"];
export type DocumentClassRank = Schemas["DocumentClassRank"];
export type TopStudents = Schemas["TopStudents"];
export type RankBasis = Schemas["RankBasis"];
export type DiplomaConfig = NonNullable<Schemas["DiplomaConfig"]>;
export type DiplomaResult = NonNullable<Schemas["DiplomaResult"]>;
export type SectionDiplomaCore = Schemas["SectionDiplomaCore"];
export type SaveDiplomaCoreBody = Schemas["SaveDiplomaCoreBody"];

/**
 * Reads behind the academic setup area (`/portal/principal/academic-setup`). Every key sits under
 * {@link GRADING_KEY} so a write can refresh the whole area at once — configuration changes ripple
 * into the overview counts, section sources, previews and certificate readiness, and refetching a
 * handful of small queries is cheaper than reasoning about which of them a change touched.
 */
export const GRADING_KEY = ["academic-grading"] as const;

export const gradingKeys = {
  overview: (yearId: string) => [...GRADING_KEY, "overview", yearId] as const,
  publishCheck: (yearId: string) => [...GRADING_KEY, "publish-check", yearId] as const,
  examTemplate: (yearId: string) => [...GRADING_KEY, "exam-template", yearId] as const,
  curriculumTemplates: (locale: string) =>
    [...GRADING_KEY, "curriculum-templates", locale] as const,
  scales: (yearId: string) => [...GRADING_KEY, "scales", yearId] as const,
  programs: (yearId: string) => [...GRADING_KEY, "programs", yearId] as const,
  gradeSubjects: (yearId: string, gradeLevelId: string) =>
    [...GRADING_KEY, "grade-subjects", yearId, gradeLevelId] as const,
  config: (configId: string) => [...GRADING_KEY, "config", configId] as const,
  impact: (configId: string) => [...GRADING_KEY, "impact", configId] as const,
  sectionSubjects: (sectionId: string) => [...GRADING_KEY, "section-subjects", sectionId] as const,
  enrollments: (sectionId: string) => [...GRADING_KEY, "enrollments", sectionId] as const,
  markSheets: (yearId: string) => [...GRADING_KEY, "mark-sheets", yearId] as const,
  proposed: (yearId: string) => [...GRADING_KEY, "proposed", yearId] as const,
  assessmentReleases: (yearId: string) => [...GRADING_KEY, "assessment-releases", yearId] as const,
  markSheet: (sectionId: string, subjectId: string) =>
    [...GRADING_KEY, "mark-sheet", sectionId, subjectId] as const,
  diplomaCore: (sectionId: string) => [...GRADING_KEY, "diploma-core", sectionId] as const,
  preview: (sectionId: string, termId: string | null) =>
    [...GRADING_KEY, "preview", sectionId, termId ?? "annual"] as const,
  finalizations: (yearId: string, sectionId: string) =>
    [...GRADING_KEY, "finalizations", yearId, sectionId] as const,
  finalization: (finalizationId: string) =>
    [...GRADING_KEY, "finalization", finalizationId] as const,
  readiness: (finalizationId: string) => [...GRADING_KEY, "readiness", finalizationId] as const,
  certificates: (finalizationId: string) =>
    [...GRADING_KEY, "certificates", finalizationId] as const,
  certificate: (certificateId: string) => [...GRADING_KEY, "certificate", certificateId] as const,
  topStudents: (yearId: string, gradeLevelId: string, termId: string | null, limit: number) =>
    [...GRADING_KEY, "top-students", yearId, gradeLevelId, termId ?? "annual", limit] as const,
};

/**
 * The response body, typed from the contract. `@studafy/api-client`'s response types turn readonly
 * arrays into array-like objects (the same gap `fetchStudentsPage` works around), so the body is
 * re-typed as the schema it is.
 */
function required<T>(data: unknown, what: string): T {
  if (data === undefined || data === null) throw new Error(`${what} returned no data.`);
  return data as T;
}

export function useGradingOverview(yearId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.overview(yearId ?? ""),
    enabled: yearId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/years/{yearId}/overview", {
        params: { path: { yearId: yearId! } },
      });
      return required<GradingOverview>(data, "Grading overview");
    },
  });
}

/** The term structure a new subject starts from: the school's exam system (School Settings). */
export function useExamTemplate(yearId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.examTemplate(yearId ?? ""),
    enabled: yearId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/years/{yearId}/exam-template", {
        params: { path: { yearId: yearId! } },
      });
      return required<ExamTemplate>(data, "Exam template");
    },
  });
}

/** The built-in curriculum templates (IGCSE, IB, American...), named in `locale`. */
export function useCurriculumTemplates(locale: CurriculumTemplateLocale, enabled = true) {
  return useQuery({
    queryKey: gradingKeys.curriculumTemplates(locale),
    enabled,
    // Code-defined on the server: they change only with a deploy.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/curriculum-templates", {
        params: { query: { locale } },
      });
      return required<Schemas["CurriculumTemplateList"]>(data, "Curriculum templates").templates;
    },
  });
}

export function usePublishCheck(yearId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: gradingKeys.publishCheck(yearId ?? ""),
    enabled: enabled && yearId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/years/{yearId}/publish-check", {
        params: { path: { yearId: yearId! } },
      });
      return required<Schemas["GradingPublishCheck"]>(data, "Publish check");
    },
  });
}

export function useGradeScales(yearId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.scales(yearId ?? ""),
    enabled: yearId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/years/{yearId}/scales", {
        params: { path: { yearId: yearId! } },
      });
      return required<Schemas["GradeScaleList"]>(data, "Grading scales").scales;
    },
  });
}

export function useGradePrograms(yearId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.programs(yearId ?? ""),
    enabled: yearId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/years/{yearId}/programs", {
        params: { path: { yearId: yearId! } },
      });
      return required<Schemas["GradeProgramList"]>(data, "Grade programs").programs;
    },
  });
}

export function useGradeSubjectConfigs(
  yearId: string | undefined,
  gradeLevelId: string | undefined,
) {
  return useQuery({
    queryKey: gradingKeys.gradeSubjects(yearId ?? "", gradeLevelId ?? ""),
    enabled: yearId !== undefined && gradeLevelId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET(
        "/api/grading/years/{yearId}/programs/{gradeLevelId}/subjects",
        {
          params: { path: { yearId: yearId!, gradeLevelId: gradeLevelId! } },
        },
      );
      return required<Schemas["SubjectConfigList"]>(data, "Grade subjects").configs;
    },
  });
}

export function useSubjectConfig(configId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.config(configId ?? ""),
    enabled: configId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/subject-configs/{configId}", {
        params: { path: { configId: configId! } },
      });
      return required<SubjectConfig>(data, "Subject configuration");
    },
  });
}

export async function fetchConfigImpact(configId: string): Promise<SubjectConfigImpact> {
  const { data } = await api.GET("/api/grading/subject-configs/{configId}/impact", {
    params: { path: { configId } },
  });
  return required<SubjectConfigImpact>(data, "Configuration impact");
}

export function useConfigImpact(configId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.impact(configId ?? ""),
    enabled: configId !== undefined,
    queryFn: () => fetchConfigImpact(configId!),
  });
}

export function useSectionGradingSubjects(sectionId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.sectionSubjects(sectionId ?? ""),
    enabled: sectionId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/sections/{sectionId}/subjects", {
        params: { path: { sectionId: sectionId! } },
      });
      return required<SectionGradingSubjects>(data, "Section subjects");
    },
  });
}

export function useSubjectEnrollments(sectionId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.enrollments(sectionId ?? ""),
    enabled: sectionId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/sections/{sectionId}/subject-enrollments", {
        params: { path: { sectionId: sectionId! } },
      });
      return required<Schemas["SubjectEnrollmentList"]>(data, "Subject enrollments").enrollments;
    },
  });
}

export type MarkSheetStatusFilter = MarkSheetSummary["status"];

export function useMarkSheets(yearId: string | undefined, status: MarkSheetStatusFilter) {
  return useQuery({
    queryKey: [...gradingKeys.markSheets(yearId ?? ""), status],
    enabled: yearId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/years/{yearId}/mark-sheets", {
        params: { path: { yearId: yearId! }, query: { status } },
      });
      return required<Schemas["MarkSheetList"]>(data, "Mark sheets").sheets;
    },
  });
}

export type AssessmentReleaseStatusFilter = AssessmentReleaseSummary["status"];

/** Single assessments teachers sent for approval before the rest of their period (000229). */
export function useAssessmentReleases(
  yearId: string | undefined,
  status: AssessmentReleaseStatusFilter,
) {
  return useQuery({
    queryKey: [...gradingKeys.assessmentReleases(yearId ?? ""), status],
    enabled: yearId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/years/{yearId}/assessment-releases", {
        params: { path: { yearId: yearId! }, query: { status } },
      });
      return required<Schemas["AssessmentReleaseList"]>(data, "Assessment releases").releases;
    },
  });
}

export function useProposedAssessments(yearId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.proposed(yearId ?? ""),
    enabled: yearId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/years/{yearId}/proposed-assessments", {
        params: { path: { yearId: yearId! } },
      });
      return required<Schemas["ProposedAssessmentList"]>(data, "Proposed assessments").assessments;
    },
  });
}

export function useMarkSheet(sectionId: string | undefined, subjectId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.markSheet(sectionId ?? "", subjectId ?? ""),
    enabled: sectionId !== undefined && subjectId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET(
        "/api/grading/sections/{sectionId}/subjects/{subjectId}/marks",
        {
          params: { path: { sectionId: sectionId!, subjectId: subjectId! } },
        },
      );
      return required<MarkSheet>(data, "Mark sheet");
    },
  });
}

/** `termId` null previews the annual result. */
/** IB Diploma core grades of a section's students (points_total grades, 000263). */
export function useSectionDiplomaCore(sectionId: string) {
  return useQuery({
    queryKey: gradingKeys.diplomaCore(sectionId),
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/sections/{sectionId}/diploma-core", {
        params: { path: { sectionId } },
      });
      return required<SectionDiplomaCore>(data, "Diploma core grades");
    },
  });
}

export function useResultPreview(sectionId: string | undefined, termId: string | null) {
  return useQuery({
    queryKey: gradingKeys.preview(sectionId ?? "", termId),
    enabled: sectionId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/sections/{sectionId}/results/preview", {
        params: {
          path: { sectionId: sectionId! },
          query: termId === null ? {} : { term_id: termId },
        },
      });
      return required<ResultPreview>(data, "Result preview");
    },
  });
}

export function useFinalizations(yearId: string | undefined, sectionId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.finalizations(yearId ?? "", sectionId ?? ""),
    enabled: yearId !== undefined && sectionId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/finalizations", {
        params: { query: { academic_year_id: yearId!, section_id: sectionId! } },
      });
      return required<Schemas["ResultFinalizationList"]>(data, "Finalizations").finalizations;
    },
  });
}

export function useFinalizationDetail(finalizationId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.finalization(finalizationId ?? ""),
    enabled: finalizationId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/finalizations/{finalizationId}", {
        params: { path: { finalizationId: finalizationId! } },
      });
      return required<ResultFinalizationDetail>(data, "Finalization");
    },
  });
}

/** A grade's top students for a term (or the year, `termId` null), by class rank. */
export function useTopStudents(
  yearId: string,
  gradeLevelId: string | undefined,
  termId: string | null,
  limit: number,
) {
  return useQuery({
    queryKey: gradingKeys.topStudents(yearId, gradeLevelId ?? "", termId, limit),
    enabled: gradeLevelId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET(
        "/api/grading/years/{yearId}/programs/{gradeLevelId}/top-students",
        {
          params: {
            path: { yearId, gradeLevelId: gradeLevelId! },
            query: { limit, ...(termId ? { term_id: termId } : {}) },
          },
        },
      );
      return required<TopStudents>(data, "Top students");
    },
  });
}

export function useCertificateReadiness(finalizationId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.readiness(finalizationId ?? ""),
    enabled: finalizationId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET(
        "/api/grading/finalizations/{finalizationId}/certificates/readiness",
        { params: { path: { finalizationId: finalizationId! } } },
      );
      return required<CertificateReadiness>(data, "Certificate readiness").students;
    },
  });
}

export function useFinalizationCertificates(finalizationId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.certificates(finalizationId ?? ""),
    enabled: finalizationId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/certificates", {
        params: { query: { finalization_id: finalizationId! } },
      });
      return required<Schemas["AcademicCertificateList"]>(data, "Certificates").certificates;
    },
  });
}

export function useCertificate(certificateId: string | undefined) {
  return useQuery({
    queryKey: gradingKeys.certificate(certificateId ?? ""),
    enabled: certificateId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/certificates/{certificateId}", {
        params: { path: { certificateId: certificateId! } },
      });
      return required<AcademicCertificate>(data, "Certificate");
    },
  });
}
