import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { GRADING_KEY } from "./queries";

import type {
  AcademicCertificate,
  CopyGradingYearSummary,
  CreateSubjectConfigBody,
  GradeProgram,
  GradeProgramBody,
  GradeScale,
  GradeScaleBody,
  GradingStatus,
  ResultFinalization,
  SaveSubjectConfigResult,
  UpdateSubjectConfigBody,
} from "./queries";
import type { components } from "@studafy/api-client";

type Schemas = components["schemas"];
export type CorrectResultsBody = Schemas["CorrectResultsBody"];
export type SubjectEnrollmentBody = Schemas["SubjectEnrollmentBody"];

/** The response body re-typed as its schema (see `required` in queries.ts for why). */
function required<T>(data: unknown, what: string): T {
  if (data === undefined || data === null) throw new Error(`${what} returned no data.`);
  return data as T;
}

/**
 * Every write in the academic setup area refreshes the whole area's cache (see `GRADING_KEY`): a
 * changed rule moves the overview counts, the sections' sources and the result previews together.
 */
function useGradingMutation<Input, Output>(mutationFn: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: GRADING_KEY }),
  });
}

// ---------------------------------------------------------------------------
// Year
// ---------------------------------------------------------------------------

export function useSetGradingStatus() {
  return useGradingMutation(
    async ({ yearId, status }: { yearId: string; status: GradingStatus }) => {
      const { data } = await api.POST("/api/grading/years/{yearId}/status", {
        params: { path: { yearId } },
        body: { status },
      });
      return required<Schemas["GradingStatusResult"]>(data, "Status change");
    },
  );
}

export function useCopyGradingYear() {
  return useGradingMutation(
    async ({
      yearId,
      sourceYearId,
      includeTeacherAssignments,
    }: {
      yearId: string;
      sourceYearId: string;
      includeTeacherAssignments: boolean;
    }): Promise<CopyGradingYearSummary> => {
      const { data } = await api.POST("/api/grading/years/{yearId}/copy", {
        params: { path: { yearId } },
        body: {
          source_year_id: sourceYearId,
          include_teacher_assignments: includeTeacherAssignments,
        },
      });
      return required<CopyGradingYearSummary>(data, "Year copy");
    },
  );
}

// ---------------------------------------------------------------------------
// Grade programs and scales
// ---------------------------------------------------------------------------

export function useSaveGradeProgram() {
  return useGradingMutation(
    async ({
      yearId,
      gradeLevelId,
      body,
    }: {
      yearId: string;
      gradeLevelId: string;
      body: GradeProgramBody;
    }): Promise<GradeProgram> => {
      const { data } = await api.PUT("/api/grading/years/{yearId}/programs/{gradeLevelId}", {
        params: { path: { yearId, gradeLevelId } },
        body,
      });
      return required<GradeProgram>(data, "Grade program");
    },
  );
}

export function useSaveGradeScale() {
  return useGradingMutation(
    async ({
      yearId,
      scaleId,
      body,
    }: {
      yearId: string;
      scaleId: string | null;
      body: GradeScaleBody;
    }): Promise<GradeScale> => {
      if (scaleId) {
        const { data } = await api.PUT("/api/grading/scales/{scaleId}", {
          params: { path: { scaleId } },
          body,
        });
        return required<GradeScale>(data, "Grading scale");
      }
      const { data } = await api.POST("/api/grading/years/{yearId}/scales", {
        params: { path: { yearId } },
        body,
      });
      return required<GradeScale>(data, "Grading scale");
    },
  );
}

export function useDeleteGradeScale() {
  return useGradingMutation(async (scaleId: string) => {
    await api.DELETE("/api/grading/scales/{scaleId}", { params: { path: { scaleId } } });
  });
}

// ---------------------------------------------------------------------------
// Subject configurations
// ---------------------------------------------------------------------------

export function useCreateSubjectConfig() {
  return useGradingMutation(
    async ({
      yearId,
      gradeLevelId,
      body,
    }: {
      yearId: string;
      gradeLevelId: string;
      body: CreateSubjectConfigBody;
    }): Promise<SaveSubjectConfigResult> => {
      const { data } = await api.POST(
        "/api/grading/years/{yearId}/programs/{gradeLevelId}/subjects",
        { params: { path: { yearId, gradeLevelId } }, body },
      );
      return required<SaveSubjectConfigResult>(data, "Subject configuration");
    },
  );
}

/** 409 `ACADEMIC_CONFIG_IMPACT_UNCONFIRMED` until the body carries `confirm_impact: true`. */
export function useUpdateSubjectConfig() {
  return useGradingMutation(
    async ({
      configId,
      body,
    }: {
      configId: string;
      body: UpdateSubjectConfigBody;
    }): Promise<SaveSubjectConfigResult> => {
      const { data } = await api.PUT("/api/grading/subject-configs/{configId}", {
        params: { path: { configId } },
        body,
      });
      return required<SaveSubjectConfigResult>(data, "Subject configuration");
    },
  );
}

export function useDeleteSubjectConfig() {
  return useGradingMutation(async (configId: string) => {
    await api.DELETE("/api/grading/subject-configs/{configId}", {
      params: { path: { configId } },
    });
  });
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export function useCreateOverride() {
  return useGradingMutation(
    async ({
      sectionId,
      subjectId,
      mode,
    }: {
      sectionId: string;
      subjectId: string;
      mode: "customize" | "exclude";
    }): Promise<SaveSubjectConfigResult> => {
      const { data } = await api.POST(
        "/api/grading/sections/{sectionId}/subjects/{subjectId}/override",
        { params: { path: { sectionId, subjectId } }, body: { mode } },
      );
      return required<SaveSubjectConfigResult>(data, "Section override");
    },
  );
}

/** Deletes the section's override so the section inherits the grade default again. */
export function useResetToGradeDefault() {
  return useGradingMutation(async (configId: string) => {
    await api.POST("/api/grading/subject-configs/{configId}/reset", {
      params: { path: { configId } },
    });
  });
}

/** Keeps the override and acknowledges the grade default's newer revision. */
export function useKeepOverride() {
  return useGradingMutation(async (configId: string) => {
    await api.POST("/api/grading/subject-configs/{configId}/keep", {
      params: { path: { configId } },
    });
  });
}

export function useAssignTeacher() {
  return useGradingMutation(
    async (body: { section_id: string; subject_id: string; teacher_id: string }) => {
      const { data } = await api.POST("/api/grading/teacher-assignments", { body });
      return required<Schemas["TeacherAssignment"]>(data, "Teacher assignment");
    },
  );
}

export function useRemoveTeacherAssignment() {
  return useGradingMutation(async (assignmentId: string) => {
    await api.DELETE("/api/grading/teacher-assignments/{assignmentId}", {
      params: { path: { assignmentId } },
    });
  });
}

export function useSetSubjectEnrollment() {
  return useGradingMutation(
    async ({ sectionId, body }: { sectionId: string; body: SubjectEnrollmentBody }) => {
      await api.PUT("/api/grading/sections/{sectionId}/subject-enrollments", {
        params: { path: { sectionId } },
        body,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export function useDecideMarkSheet() {
  return useGradingMutation(
    async ({
      sheetId,
      action,
      reason,
    }: {
      sheetId: string;
      action: "approve" | "return" | "reopen";
      reason?: string;
    }) => {
      const { data } = await api.POST("/api/grading/mark-sheets/{sheetId}/decision", {
        params: { path: { sheetId } },
        body: { action, reason: reason ?? null },
      });
      return required<Schemas["MarkSheetStatus"]>(data, "Mark sheet decision");
    },
  );
}

export function useDecideAssessment() {
  return useGradingMutation(
    async ({ assessmentId, action }: { assessmentId: string; action: "approve" | "reject" }) => {
      await api.POST("/api/grading/assessments/{assessmentId}/decision", {
        params: { path: { assessmentId } },
        body: { action },
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Results and certificates
// ---------------------------------------------------------------------------

export function useFinalizeResults() {
  return useGradingMutation(
    async ({
      sectionId,
      termId,
      allowIncomplete,
    }: {
      sectionId: string;
      termId: string | null;
      allowIncomplete: boolean;
    }): Promise<ResultFinalization> => {
      const { data } = await api.POST("/api/grading/sections/{sectionId}/results/finalize", {
        params: { path: { sectionId } },
        body: { term_id: termId, allow_incomplete: allowIncomplete },
      });
      return required<ResultFinalization>(data, "Finalization");
    },
  );
}

export function useCorrectResults() {
  return useGradingMutation(
    async ({
      finalizationId,
      body,
    }: {
      finalizationId: string;
      body: CorrectResultsBody;
    }): Promise<ResultFinalization> => {
      const { data } = await api.POST("/api/grading/finalizations/{finalizationId}/corrections", {
        params: { path: { finalizationId } },
        body,
      });
      return required<ResultFinalization>(data, "Correction");
    },
  );
}

export function useIssueCertificates() {
  return useGradingMutation(
    async ({ finalizationId, studentIds }: { finalizationId: string; studentIds?: string[] }) => {
      const { data } = await api.POST("/api/grading/finalizations/{finalizationId}/certificates", {
        params: { path: { finalizationId } },
        body: studentIds ? { student_ids: studentIds } : {},
      });
      return required<Schemas["IssueCertificatesResult"]>(data, "Certificate issue");
    },
  );
}

export function useReissueCertificate() {
  return useGradingMutation(
    async ({
      certificateId,
      reason,
    }: {
      certificateId: string;
      reason: string;
    }): Promise<AcademicCertificate> => {
      const { data } = await api.POST("/api/grading/certificates/{certificateId}/reissue", {
        params: { path: { certificateId } },
        body: { reason },
      });
      return required<AcademicCertificate>(data, "Certificate reissue");
    },
  );
}

export function useRevokeCertificate() {
  return useGradingMutation(
    async ({
      certificateId,
      reason,
    }: {
      certificateId: string;
      reason: string;
    }): Promise<AcademicCertificate> => {
      const { data } = await api.POST("/api/grading/certificates/{certificateId}/revoke", {
        params: { path: { certificateId } },
        body: { reason },
      });
      return required<AcademicCertificate>(data, "Certificate revoke");
    },
  );
}
