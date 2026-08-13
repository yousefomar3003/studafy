/** Funnel event names for the school registration flow. See `lib/analytics.ts`. */
export const ONBOARDING_EVENTS = {
  REGISTRATION_STARTED: "onboarding_registration_started",
  STEP_COMPLETED: "onboarding_step_completed",
  REGISTRATION_SUBMITTED: "onboarding_registration_submitted",
  REGISTRATION_SUCCEEDED: "onboarding_registration_succeeded",
  REGISTRATION_FAILED: "onboarding_registration_failed",
  VERIFICATION_RESEND_REQUESTED: "onboarding_verification_resend_requested",
  VERIFICATION_RESEND_SUCCEEDED: "onboarding_verification_resend_succeeded",
} as const;
