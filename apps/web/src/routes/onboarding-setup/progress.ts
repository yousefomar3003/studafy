import type { SchoolProfileValues } from "./schema";

/**
 * Client-side persistence for the post-activation setup wizard's progress, so an admin who closes
 * the tab mid-way (or refreshes after a slow step) resumes exactly where they left off instead of
 * restarting. There is no server-side "wizard progress" table in the backend today, so this is
 * `localStorage`-backed and scoped to the browser the admin used — switching devices starts fresh.
 *
 * `version` lets a future shape change discard old, incompatible stored data on read instead of
 * crashing on it.
 */

export const STEP_IDS = [
  "school-profile",
  "academic-year",
  "grading-scheme",
  "timetable",
  "staff",
  "students",
] as const;

export type StepId = (typeof STEP_IDS)[number];

export type StepState = "upcoming" | "completed" | "skipped";

export type SchoolProfileProgress = SchoolProfileValues;

export interface AcademicYearProgress {
  yearId: string;
  termId: string;
  code: string;
  name: string;
  starts_on: string;
  ends_on: string;
}

export interface GradingSchemeProgress {
  schemeId: string;
  name: string;
  schemeType: string;
}

export interface TimetableProgress {
  versionId: string;
  name: string;
  periodsPerDay: number;
  weekdays: number[];
}

export interface StaffInviteBatchResult {
  role: string;
  totalCount: number;
  sentCount: number;
}

export interface StaffInvitesProgress {
  batches: StaffInviteBatchResult[];
}

export interface StudentImportProgress {
  importId: string;
  status: string;
}

export interface WizardProgress {
  version: 1;
  currentStep: StepId | "complete";
  stepState: Record<StepId, StepState>;
  schoolProfile?: SchoolProfileProgress;
  academicYear?: AcademicYearProgress;
  gradingScheme?: GradingSchemeProgress;
  timetable?: TimetableProgress;
  staffInvites?: StaffInvitesProgress;
  studentImport?: StudentImportProgress;
}

const STORAGE_KEY = "studafy.onboarding-setup.v1";

function initialStepState(): Record<StepId, StepState> {
  return Object.fromEntries(STEP_IDS.map((id) => [id, "upcoming"])) as Record<StepId, StepState>;
}

export function defaultProgress(): WizardProgress {
  return { version: 1, currentStep: STEP_IDS[0], stepState: initialStepState() };
}

/** The step after `stepId`, or `"complete"` once every step has been passed. */
export function nextStepAfter(stepId: StepId): StepId | "complete" {
  const index = STEP_IDS.indexOf(stepId);
  return STEP_IDS[index + 1] ?? "complete";
}

export function loadProgress(): WizardProgress {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultProgress();
    const parsed = JSON.parse(raw) as Partial<WizardProgress>;
    if (parsed.version !== 1) return defaultProgress();
    return {
      ...defaultProgress(),
      ...parsed,
      stepState: { ...initialStepState(), ...parsed.stepState },
    };
  } catch {
    return defaultProgress();
  }
}

export function saveProgress(progress: WizardProgress): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
}

export function clearProgress(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
