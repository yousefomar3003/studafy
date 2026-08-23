import { ApiError } from "@studafy/api-client";
import { Button, Card, CardBody } from "@studafy/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  ACTIVATION_EVENTS,
  FEATURE_EVENTS,
  SETUP_WIZARD_FEATURES,
  track,
} from "../../lib/analytics";
import { api } from "../../lib/api";

import { clearProgress, loadProgress, nextStepAfter, saveProgress } from "./progress";
import { AcademicYearStep } from "./steps/AcademicYearStep";
import { GradingSchemeStep } from "./steps/GradingSchemeStep";
import { SchoolProfileStep } from "./steps/SchoolProfileStep";
import { StaffInvitationsStep } from "./steps/StaffInvitationsStep";
import { StudentImportStep } from "./steps/StudentImportStep";
import { TimetableStep } from "./steps/TimetableStep";
import { WizardStepper } from "./WizardStepper";

import type { StepId, WizardProgress } from "./progress";
import type {
  AcademicYearValues,
  GradingSchemeValues,
  SchoolProfileValues,
  StaffInviteBatch,
  TimetableValues,
} from "./schema";

/** Full-year term auto-created alongside the academic year — see AcademicYearStep's doc comment. */
function fullYearTermBody(values: AcademicYearValues, yearId: string) {
  return {
    academic_year_id: yearId,
    code: "FY",
    name: "Full Year",
    sequence_number: 1,
    starts_on: values.starts_on,
    ends_on: values.ends_on,
    status: "active" as const,
  };
}

/**
 * Post-activation setup wizard (`/onboarding/setup`). Each step persists to the real backend
 * endpoint it corresponds to (see the per-step doc comments for the exact contract); progress is
 * mirrored into `localStorage` after every change so closing the tab mid-way and coming back
 * resumes exactly where the admin left off (`progress.ts`).
 */
export default function SetupWizardPage() {
  const navigate = useNavigate();
  const [progress, setProgress] = useState<WizardProgress>(() => loadProgress());
  const [banner, setBanner] = useState<string | null>(null);

  function persist(next: WizardProgress) {
    setProgress(next);
    saveProgress(next);
  }

  function completeStep(stepId: StepId, patch: Partial<WizardProgress>) {
    setBanner(null);
    track(ACTIVATION_EVENTS.SETUP_STEP_COMPLETED, { step: stepId });
    // eslint-disable-next-line security/detect-object-injection -- `stepId` is `StepId`, a fixed set of literal step names, not user-controlled
    track(FEATURE_EVENTS.USED, { feature: SETUP_WIZARD_FEATURES[stepId] });
    const currentStep = nextStepAfter(stepId);
    if (currentStep === "complete") {
      track(ACTIVATION_EVENTS.SETUP_COMPLETED);
    }
    persist({
      ...progress,
      ...patch,
      stepState: { ...progress.stepState, [stepId]: "completed" },
      currentStep,
    });
  }

  function skipStep(stepId: StepId) {
    setBanner(null);
    track(ACTIVATION_EVENTS.SETUP_STEP_SKIPPED, { step: stepId });
    const currentStep = nextStepAfter(stepId);
    if (currentStep === "complete") {
      track(ACTIVATION_EVENTS.SETUP_COMPLETED);
    }
    persist({
      ...progress,
      stepState: { ...progress.stepState, [stepId]: "skipped" },
      currentStep,
    });
  }

  function goToStep(stepId: StepId) {
    setBanner(null);
    persist({ ...progress, currentStep: stepId });
  }

  function handleError(error: unknown, fallback: string) {
    const apiError = error instanceof ApiError ? error : null;
    setBanner(apiError?.detail || fallback);
  }

  const schoolProfileMutation = useMutation({
    mutationFn: async (values: SchoolProfileValues) => {
      await api.PATCH("/api/schools/current/settings", { body: values });
      return values;
    },
    onSuccess: (values) => completeStep("school-profile", { schoolProfile: values }),
    onError: (error) => handleError(error, "Could not save school settings. Please try again."),
  });

  const academicYearMutation = useMutation({
    mutationFn: async (values: AcademicYearValues) => {
      const { data: year } = await api.POST("/api/academics/years", {
        body: { ...values, status: "active" },
      });
      if (!year) throw new Error("Academic year creation returned no data.");
      const { data: term } = await api.POST("/api/academics/years/{yearId}/terms", {
        params: { path: { yearId: year.id } },
        body: fullYearTermBody(values, year.id),
      });
      if (!term) throw new Error("Term creation returned no data.");
      return { yearId: year.id, termId: term.id, ...values };
    },
    onSuccess: (result) => completeStep("academic-year", { academicYear: result }),
    onError: (error) => handleError(error, "Could not create the academic year. Please try again."),
  });

  const gradingSchemeMutation = useMutation({
    mutationFn: async (values: GradingSchemeValues) => {
      const termId = progress.academicYear?.termId;
      if (!termId) throw new Error("An academic year is required before a grading scheme.");
      const { data: scheme } = await api.POST("/api/grades/config/schemes", {
        body: { term_id: termId, ...values },
      });
      if (!scheme) throw new Error("Grading scheme creation returned no data.");
      // Keeps the school-wide default (`settings.grading_scheme`) in step with the concrete scheme
      // just created, so the two don't silently disagree.
      await api.PATCH("/api/schools/current/settings", {
        body: { grading_scheme: values.scheme_type },
      });
      return { schemeId: scheme.id, name: values.name, schemeType: values.scheme_type };
    },
    onSuccess: (result) => completeStep("grading-scheme", { gradingScheme: result }),
    onError: (error) => handleError(error, "Could not save the grading scheme. Please try again."),
  });

  const timetableMutation = useMutation({
    mutationFn: async (values: TimetableValues) => {
      const yearId = progress.academicYear?.yearId;
      const termId = progress.academicYear?.termId;
      if (!yearId || !termId) throw new Error("An academic year is required before a timetable.");
      const { data: version } = await api.POST("/api/academics/timetable-versions", {
        body: { term_id: termId, academic_year_id: yearId, name: values.name },
      });
      if (!version) throw new Error("Timetable version creation returned no data.");
      return {
        versionId: version.id,
        name: values.name,
        periodsPerDay: values.periods_per_day,
        weekdays: values.weekdays,
      };
    },
    onSuccess: (result) => completeStep("timetable", { timetable: result }),
    onError: (error) => handleError(error, "Could not create the timetable. Please try again."),
  });

  const staffInvitesMutation = useMutation({
    mutationFn: async (batches: StaffInviteBatch[]) => {
      const results = [];
      for (const batch of batches) {
        const { data } = await api.POST("/api/invitations/bulk", {
          body: { role: batch.role, recipients: batch.emails.map((email) => ({ email })) },
        });
        results.push({
          role: batch.role,
          totalCount: data?.total_count ?? batch.emails.length,
          sentCount: data?.sent_count ?? 0,
        });
      }
      return results;
    },
    onSuccess: (batches) => completeStep("staff", { staffInvites: { batches } }),
    onError: (error) => handleError(error, "Could not send invitations. Please try again."),
  });

  if (progress.currentStep === "complete") {
    return (
      <Card>
        <CardBody>
          <h2>Setup complete</h2>
          <p>Your school is ready. You can revisit any of these settings later from the portal.</p>
          <Button
            type="button"
            onClick={() => {
              clearProgress();
              void navigate("/portal");
            }}
          >
            Go to dashboard
          </Button>
        </CardBody>
      </Card>
    );
  }

  return (
    <div>
      <WizardStepper
        currentStep={progress.currentStep}
        stepState={progress.stepState}
        onSelect={goToStep}
      />

      {banner ? <p role="alert">{banner}</p> : null}

      {progress.currentStep === "school-profile" ? (
        <SchoolProfileStep
          cachedValues={progress.schoolProfile}
          submitting={schoolProfileMutation.isPending}
          onNext={(values) => schoolProfileMutation.mutate(values)}
          onSkip={() => skipStep("school-profile")}
        />
      ) : null}

      {progress.currentStep === "academic-year" ? (
        <AcademicYearStep
          cachedValues={
            progress.academicYear
              ? {
                  code: progress.academicYear.code,
                  name: progress.academicYear.name,
                  starts_on: progress.academicYear.starts_on,
                  ends_on: progress.academicYear.ends_on,
                }
              : undefined
          }
          submitting={academicYearMutation.isPending}
          onNext={(values) => academicYearMutation.mutate(values)}
          onSkip={() => skipStep("academic-year")}
        />
      ) : null}

      {progress.currentStep === "grading-scheme" ? (
        <GradingSchemeStep
          termId={progress.academicYear?.termId}
          submitting={gradingSchemeMutation.isPending}
          onNext={(values) => gradingSchemeMutation.mutate(values)}
          onSkip={() => skipStep("grading-scheme")}
          onGoToAcademicYear={() => goToStep("academic-year")}
        />
      ) : null}

      {progress.currentStep === "timetable" ? (
        <TimetableStep
          yearId={progress.academicYear?.yearId}
          termId={progress.academicYear?.termId}
          cachedValues={
            progress.timetable
              ? {
                  name: progress.timetable.name,
                  periods_per_day: progress.timetable.periodsPerDay,
                  weekdays: progress.timetable.weekdays,
                }
              : undefined
          }
          submitting={timetableMutation.isPending}
          onNext={(values) => timetableMutation.mutate(values)}
          onSkip={() => skipStep("timetable")}
          onGoToAcademicYear={() => goToStep("academic-year")}
        />
      ) : null}

      {progress.currentStep === "staff" ? (
        <StaffInvitationsStep
          submitting={staffInvitesMutation.isPending}
          onNext={(batches) => staffInvitesMutation.mutate(batches)}
          onSkip={() => skipStep("staff")}
        />
      ) : null}

      {progress.currentStep === "students" ? (
        <StudentImportStep
          cachedImport={progress.studentImport}
          onNext={(studentImport) => completeStep("students", { studentImport })}
          onSkip={() => skipStep("students")}
        />
      ) : null}
    </div>
  );
}
