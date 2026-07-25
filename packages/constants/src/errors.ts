/**
 * Typed, unique error codes shared across services. Uniqueness of values (not just keys) is
 * enforced by a unit test — see errors.test.ts.
 */
export const ERROR_CODES = {
  // Authentication — identity of the caller could not be established.
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  AUTH_TOKEN_EXPIRED: "AUTH_TOKEN_EXPIRED",
  AUTH_TOKEN_INVALID: "AUTH_TOKEN_INVALID",
  AUTH_SESSION_NOT_FOUND: "AUTH_SESSION_NOT_FOUND",

  // Invitation verification — public invitation lifecycle resolution.
  INVITATION_INVALID: "INVITATION_INVALID",
  EXPIRED: "EXPIRED",
  REVOKED: "REVOKED",
  CONSUMED: "CONSUMED",
  SCHOOL_SUSPENDED: "SCHOOL_SUSPENDED",

  // OAuth — external identity provider flow.
  OAUTH_STATE_INVALID: "OAUTH_STATE_INVALID",
  OAUTH_EMAIL_NOT_VERIFIED: "OAUTH_EMAIL_NOT_VERIFIED",
  OAUTH_PROVIDER_ERROR: "OAUTH_PROVIDER_ERROR",
  OAUTH_LAST_PROVIDER: "OAUTH_LAST_PROVIDER",
  OAUTH_IDENTITY_EXISTS: "OAUTH_IDENTITY_EXISTS",

  // Returning-user login — no matching OAuth identity found for the incoming (provider, sub) pair.
  NO_ACCOUNT: "NO_ACCOUNT",

  // Account activation — the OAuth identity diverged from the invitation's bound email, so
  // automatic provisioning is withheld pending an administrator's decision.
  REQUIRES_ADMIN_APPROVAL: "REQUIRES_ADMIN_APPROVAL",

  // Authorization — caller is known, but not permitted.
  AUTHZ_FORBIDDEN: "AUTHZ_FORBIDDEN",
  AUTHZ_ROLE_NOT_FOUND: "AUTHZ_ROLE_NOT_FOUND",
  AUTHZ_PERMISSION_NOT_FOUND: "AUTHZ_PERMISSION_NOT_FOUND",

  // Channel policy — the caller's session channel is not authorized for this operation.
  CHANNEL_NOT_AUTHORIZED: "CHANNEL_NOT_AUTHORIZED",

  // Validation — caller input was malformed.
  VALIDATION_FAILED: "VALIDATION_FAILED",
  VALIDATION_REQUIRED_FIELD_MISSING: "VALIDATION_REQUIRED_FIELD_MISSING",

  // Resource — the requested entity does not exist or was already removed.
  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
  RESOURCE_ALREADY_DELETED: "RESOURCE_ALREADY_DELETED",

  // School registration — duplicate school email or slug on registration.
  SCHOOL_EMAIL_DUPLICATE: "SCHOOL_EMAIL_DUPLICATE",
  SCHOOL_SLUG_DUPLICATE: "SCHOOL_SLUG_DUPLICATE",

  // School email verification — the presented token failed server-side verification.
  VERIFICATION_TOKEN_INVALID: "VERIFICATION_TOKEN_INVALID",
  VERIFICATION_TOKEN_EXPIRED: "VERIFICATION_TOKEN_EXPIRED",
  VERIFICATION_TOKEN_CONSUMED: "VERIFICATION_TOKEN_CONSUMED",

  // Captcha — the presented token failed server-side verification.
  CAPTCHA_INVALID: "CAPTCHA_INVALID",

  // Conflict — the request contradicts current server state.
  CONFLICT_DUPLICATE_ENTRY: "CONFLICT_DUPLICATE_ENTRY",
  CONFLICT_STATE_MISMATCH: "CONFLICT_STATE_MISMATCH",
  CONFLICT_IDEMPOTENCY_KEY_MISMATCH: "CONFLICT_IDEMPOTENCY_KEY_MISMATCH",

  // User management — duplicate email or invalid role assignment within a school.
  USER_EMAIL_DUPLICATE: "USER_EMAIL_DUPLICATE",
  INVALID_ROLE_ASSIGNMENT: "INVALID_ROLE_ASSIGNMENT",

  // Student — duplicate admission number within a school.
  STUDENT_ADMISSION_DUPLICATE: "STUDENT_ADMISSION_DUPLICATE",

  // Teacher — duplicate employee number within a school.
  TEACHER_EMPLOYEE_NUMBER_DUPLICATE: "TEACHER_EMPLOYEE_NUMBER_DUPLICATE",

  // Parent-child linking — link/unlink constraints.
  PARENT_LINK_EXISTS: "PARENT_LINK_EXISTS",
  PARENT_NOT_LINKED: "PARENT_NOT_LINKED",
  PARENT_INVALID_ROLE: "PARENT_INVALID_ROLE",

  // Academic — year/term lifecycle violations.
  ACADEMIC_YEAR_ACTIVE_EXISTS: "ACADEMIC_YEAR_ACTIVE_EXISTS",
  ACADEMIC_YEAR_DATE_OVERLAP: "ACADEMIC_YEAR_DATE_OVERLAP",

  // Subject / course — catalog entity lifecycle.
  SUBJECT_HAS_COURSES: "SUBJECT_HAS_COURSES",
  COURSE_HAS_CLASSES: "COURSE_HAS_CLASSES",

  // Tenant lifecycle — subscription state machine enforcement (ST-092).
  LIMIT_EXCEEDED_STUDENT_CAP: "LIMIT_EXCEEDED_STUDENT_CAP",
  TENANT_SUSPENDED: "TENANT_SUSPENDED",
  TENANT_CLOSED: "TENANT_CLOSED",

  // Rate limiting.
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",

  // Tenant provisioning — multi-step pipeline failures.
  PROVISIONING_FAILED: "PROVISIONING_FAILED",
  PROVISIONING_IN_PROGRESS: "PROVISIONING_IN_PROGRESS",
  ERPNEXT_SITE_CREATION_FAILED: "ERPNEXT_SITE_CREATION_FAILED",
  ERPNEXT_COMPANY_CREATION_FAILED: "ERPNEXT_COMPANY_CREATION_FAILED",

  // Import — CSV import lifecycle.
  IMPORT_NOT_FOUND: "IMPORT_NOT_FOUND",
  IMPORT_INVALID_STATE: "IMPORT_INVALID_STATE",
  IMPORT_VALIDATION_FAILED: "IMPORT_VALIDATION_FAILED",
  IMPORT_ROWS_EXCEED_LIMIT: "IMPORT_ROWS_EXCEED_LIMIT",
  IMPORT_IDEMPOTENCY_KEY_EXISTS: "IMPORT_IDEMPOTENCY_KEY_EXISTS",

  // Uncategorized server-side failure.
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
