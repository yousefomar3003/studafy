import { Chip } from "@studafy/ui";

import { useTranslation } from "../../lib/i18n";

import { STEP_IDS } from "./progress";

import type { StepId, StepState } from "./progress";

/** Translation keys for each step's label — resolved with `t()` at render time. */
const STEP_LABEL_KEYS: Record<StepId, string> = {
  "school-profile": "onboarding.setup.steps.schoolProfile",
  "academic-year": "onboarding.setup.steps.academicYear",
  "grading-scheme": "onboarding.setup.steps.gradingScheme",
  timetable: "onboarding.setup.steps.timetable",
  staff: "onboarding.setup.steps.staff",
  students: "onboarding.setup.steps.students",
};

export interface WizardStepperProps {
  currentStep: StepId | "complete";
  stepState: Record<StepId, StepState>;
  /** A step is only a valid jump target once it has been reached — resumability, not free navigation. */
  onSelect: (step: StepId) => void;
}

function chipVariant(state: StepState, isCurrent: boolean): "filled" | "outlined" {
  return isCurrent || state === "completed" ? "filled" : "outlined";
}

function statusLabelKey(state: StepState, isCurrent: boolean): string {
  if (isCurrent) return "onboarding.setup.stepStatus.current";
  if (state === "completed") return "onboarding.setup.stepStatus.done";
  if (state === "skipped") return "onboarding.setup.stepStatus.skipped";
  return "onboarding.setup.stepStatus.notStarted";
}

/** Step rail for the setup wizard. Visited steps (done or skipped) are clickable so an admin can jump back. */
export function WizardStepper({ currentStep, stepState, onSelect }: WizardStepperProps) {
  const { t } = useTranslation();

  return (
    <nav aria-label={t("onboarding.setup.stepsNavLabel")}>
      <ol>
        {STEP_IDS.map((step, index) => {
          const isCurrent = step === currentStep;
          // eslint-disable-next-line security/detect-object-injection -- `step` comes from iterating this module's own fixed `STEP_IDS` tuple, not user input
          const state = stepState[step];
          const visited = state !== "upcoming" || isCurrent;

          return (
            <li key={step}>
              <button
                type="button"
                onClick={() => onSelect(step)}
                disabled={!visited}
                aria-current={isCurrent ? "step" : undefined}
              >
                {t("onboarding.setup.stepLabel", {
                  number: index + 1,
                  // eslint-disable-next-line security/detect-object-injection -- same as above
                  label: t(STEP_LABEL_KEYS[step]),
                })}
              </button>
              <Chip variant={chipVariant(state, isCurrent)}>
                {t(statusLabelKey(state, isCurrent))}
              </Chip>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
