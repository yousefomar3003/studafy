import { Chip } from "@studafy/ui";

import { STEP_IDS } from "./progress";

import type { StepId, StepState } from "./progress";

const STEP_LABELS: Record<StepId, string> = {
  "school-profile": "School profile",
  "academic-year": "Academic year",
  "grading-scheme": "Grading scheme",
  timetable: "Timetable periods",
  staff: "Staff invitations",
  students: "Student import",
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

function statusLabel(state: StepState, isCurrent: boolean): string {
  if (isCurrent) return "current";
  if (state === "completed") return "done";
  if (state === "skipped") return "skipped";
  return "not started";
}

/** Step rail for the setup wizard. Visited steps (done or skipped) are clickable so an admin can jump back. */
export function WizardStepper({ currentStep, stepState, onSelect }: WizardStepperProps) {
  return (
    <nav aria-label="Setup steps">
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
                {/* eslint-disable-next-line security/detect-object-injection -- same as above */}
                {index + 1}. {STEP_LABELS[step]}
              </button>
              <Chip variant={chipVariant(state, isCurrent)}>{statusLabel(state, isCurrent)}</Chip>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
