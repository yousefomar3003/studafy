import { helpPath } from "./content";

/**
 * The onboarding wizard's step links point into the onboarding guide article. Anchors must match
 * the `Step N: …` headings in `/docs/help/getting-started/onboarding-guide.md` after `slugify` —
 * `content.test.ts` verifies the sync automatically.
 */
export const ONBOARDING_GUIDE_SLUG = "onboarding-guide";

export const ONBOARDING_STEP_ANCHORS = {
  schoolProfile: "step-1-school-profile",
  academicYear: "step-2-academic-year",
  gradingScheme: "step-3-grading-scheme",
  timetable: "step-4-timetable-periods",
  staff: "step-5-staff-invitations",
  students: "step-6-student-import",
} as const;

export function onboardingStepHelpPath(step: keyof typeof ONBOARDING_STEP_ANCHORS): string {
  return `${helpPath(ONBOARDING_GUIDE_SLUG)}#${ONBOARDING_STEP_ANCHORS[step]}`;
}
