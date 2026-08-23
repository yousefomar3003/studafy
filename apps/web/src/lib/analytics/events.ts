/**
 * Canonical event catalog for the funnels this app instruments. Naming convention: snake_case,
 * `<domain>_<subject>_<verb, past tense>`, no PII in the name itself (see `docs/analytics-event-schema.md`
 * for the full schema — every event's trigger and properties are documented there, not just here).
 *
 * One event, `feature_used`, covers all of feature adoption — a `feature` property distinguishes
 * which capability fired it, rather than minting a new event name per feature. That keeps the
 * catalog from growing one constant per feature while staying just as queryable downstream (funnel
 * and retention tooling groups by property as naturally as by event name).
 */

/** The public school self-registration flow (`/onboarding`). */
export const REGISTRATION_EVENTS = {
  STARTED: "registration_started",
  STEP_COMPLETED: "registration_step_completed",
  SUBMITTED: "registration_submitted",
  SUCCEEDED: "registration_succeeded",
  FAILED: "registration_failed",
  VERIFICATION_RESEND_REQUESTED: "registration_verification_resend_requested",
  VERIFICATION_RESEND_SUCCEEDED: "registration_verification_resend_succeeded",
} as const;

/**
 * From invitation link to a working, configured account: invite verification, the OAuth activation
 * hop, and the post-activation setup wizard (`/onboarding/setup`).
 */
export const ACTIVATION_EVENTS = {
  INVITATION_VIEWED: "activation_invitation_viewed",
  INVITATION_INVALID: "activation_invitation_invalid",
  OAUTH_STARTED: "activation_oauth_started",
  SUCCEEDED: "activation_succeeded",
  ADMIN_APPROVAL_REQUIRED: "activation_admin_approval_required",
  SETUP_STEP_COMPLETED: "activation_setup_step_completed",
  SETUP_STEP_SKIPPED: "activation_setup_step_skipped",
  SETUP_COMPLETED: "activation_setup_completed",
} as const;

/** Adoption of a core product capability, first use and every use after. */
export const FEATURE_EVENTS = {
  USED: "feature_used",
} as const;

/**
 * The `feature` property value `FEATURE_EVENTS.USED` carries for each setup-wizard step — the
 * wizard is where a school first adopts each of these capabilities, so its step completions double
 * as that feature's adoption signal.
 */
export const SETUP_WIZARD_FEATURES = {
  "school-profile": "school_profile",
  "academic-year": "academic_year",
  "grading-scheme": "grading_scheme",
  timetable: "timetable",
  staff: "staff_invitations",
  students: "student_import",
} as const;
