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
  // The token is cryptographically valid and unrevoked, but its entitlements_ver claim predates the
  // subject's current entitlement version (ST-133) — a subscription changed after it was minted.
  // Distinct from AUTH_TOKEN_INVALID so a client can tell "refresh and retry" apart from "your
  // credential is bad"; the remedy is one call to POST /api/auth/refresh.
  AUTH_ENTITLEMENTS_STALE: "AUTH_ENTITLEMENTS_STALE",

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
  // The user declined the provider's consent screen (the provider bounced `error=access_denied`
  // instead of a code). Never emitted as a problem+json `code` — the OAuth callbacks redirect it to
  // the frontend `/auth/error` page so the UI can say "you cancelled" rather than "something broke".
  OAUTH_CANCELLED: "OAUTH_CANCELLED",

  // Returning-user login — no matching OAuth identity found for the incoming (provider, sub) pair.
  NO_ACCOUNT: "NO_ACCOUNT",

  // Account activation — the OAuth identity diverged from the invitation's bound email, so
  // automatic provisioning is withheld pending an administrator's decision.
  REQUIRES_ADMIN_APPROVAL: "REQUIRES_ADMIN_APPROVAL",

  // Authorization — caller is known, but not permitted.
  AUTHZ_FORBIDDEN: "AUTHZ_FORBIDDEN",
  ACCESS_DENIED: "ACCESS_DENIED",
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

  // Class — delivery entity lifecycle.
  CLASS_HAS_ENROLLMENTS: "CLASS_HAS_ENROLLMENTS",
  CLASS_CAPACITY_EXCEEDED: "CLASS_CAPACITY_EXCEEDED",

  // Enrollment — student-class binding.
  ENROLLMENT_DUPLICATE: "ENROLLMENT_DUPLICATE",
  ENROLLMENT_NOT_ACTIVE: "ENROLLMENT_NOT_ACTIVE",

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

  // ERPNext gateway — upstream availability, distinguished from each other because a client can act
  // on the difference: a timeout is worth retrying, an open circuit is not (ST-119).
  ERPNEXT_NOT_CONFIGURED: "ERPNEXT_NOT_CONFIGURED",
  FINANCE_REPORT_NOT_FOUND: "FINANCE_REPORT_NOT_FOUND",
  FINANCE_REPORT_EXPORT_UNAVAILABLE: "FINANCE_REPORT_EXPORT_UNAVAILABLE",
  JOINVOICE_INVOICE_NOT_FOUND: "JOINVOICE_INVOICE_NOT_FOUND",
  JOINVOICE_INVALID_INVOICE: "JOINVOICE_INVALID_INVOICE",
  JOINVOICE_INVOICE_CHANGED: "JOINVOICE_INVOICE_CHANGED",
  ERPNEXT_UNAVAILABLE: "ERPNEXT_UNAVAILABLE",
  ERPNEXT_TIMEOUT: "ERPNEXT_TIMEOUT",
  ERPNEXT_CIRCUIT_OPEN: "ERPNEXT_CIRCUIT_OPEN",

  // Finance gateway — fee structures (ST-119).
  FEE_STRUCTURE_NOT_FOUND: "FEE_STRUCTURE_NOT_FOUND",

  // Finance gateway — fee schedules / installments (ST-122).
  FEE_SCHEDULE_NOT_FOUND: "FEE_SCHEDULE_NOT_FOUND",

  // Finance reconciliation — cache drift that could not be auto-healed (ST-122).
  RECONCILIATION_DIVERGENCE: "RECONCILIATION_DIVERGENCE",

  // Invoice generation — billing worker.
  INVOICE_ALREADY_EXISTS: "INVOICE_ALREADY_EXISTS",
  INVOICE_GENERATION_FAILED: "INVOICE_GENERATION_FAILED",
  INVOICE_STUDENT_NOT_FOUND: "INVOICE_STUDENT_NOT_FOUND",

  // Finance gateway — expenses.
  EXPENSE_NOT_FOUND: "EXPENSE_NOT_FOUND",

  // Finance gateway — payments (ST-121). Reusing a key for a different body is reported with the
  // existing CONFLICT_IDEMPOTENCY_KEY_MISMATCH above rather than a payment-specific twin; the
  // condition is not payment-specific and one code for it keeps client handling uniform.
  PAYMENT_NOT_FOUND: "PAYMENT_NOT_FOUND",
  // Distinct from a mismatch, because the client acts differently: an earlier request with this key
  // reached ERPNext and its outcome is not yet known, so the answer is to wait and re-read rather
  // than to change anything. Never retry-with-a-new-key on this one — that is the double charge.
  PAYMENT_IN_PROGRESS: "PAYMENT_IN_PROGRESS",
  PAYMENT_IDEMPOTENCY_KEY_REQUIRED: "PAYMENT_IDEMPOTENCY_KEY_REQUIRED",

  // Finance gateway — refunds (ST-124).
  REFUND_NOT_FOUND: "REFUND_NOT_FOUND",
  REFUND_INVALID_STATUS: "REFUND_INVALID_STATUS",
  REFUND_CONFIRM_SELF: "REFUND_CONFIRM_SELF",
  REFUND_IN_PROGRESS: "REFUND_IN_PROGRESS",
  REFUND_IDEMPOTENCY_KEY_REQUIRED: "REFUND_IDEMPOTENCY_KEY_REQUIRED",

  // Finance gateway — scholarships / discounts.
  SCHOLARSHIP_DISCOUNT_NOT_FOUND: "SCHOLARSHIP_DISCOUNT_NOT_FOUND",
  AWARD_NOT_FOUND: "AWARD_NOT_FOUND",
  AWARD_INVALID_STATUS_TRANSITION: "AWARD_INVALID_STATUS_TRANSITION",
  AWARD_CONFIRM_SELF: "AWARD_CONFIRM_SELF",

  // Import — CSV import lifecycle.
  IMPORT_NOT_FOUND: "IMPORT_NOT_FOUND",
  IMPORT_INVALID_STATE: "IMPORT_INVALID_STATE",
  IMPORT_VALIDATION_FAILED: "IMPORT_VALIDATION_FAILED",
  IMPORT_ROWS_EXCEED_LIMIT: "IMPORT_ROWS_EXCEED_LIMIT",
  IMPORT_IDEMPOTENCY_KEY_EXISTS: "IMPORT_IDEMPOTENCY_KEY_EXISTS",

  // Exam — scheduling and lifecycle.
  EXAM_NOT_FOUND: "EXAM_NOT_FOUND",
  EXAM_INVALID_STATE: "EXAM_INVALID_STATE",

  // Timetable — scheduling conflicts and state-machine violations.
  TIMETABLE_TEACHER_CONFLICT: "TIMETABLE_TEACHER_CONFLICT",
  TIMETABLE_ROOM_CONFLICT: "TIMETABLE_ROOM_CONFLICT",
  TIMETABLE_VERSION_NOT_DRAFT: "TIMETABLE_VERSION_NOT_DRAFT",

  // Assignments — class-scope violations and lifecycle constraints.
  ASSIGNMENT_CLASS_FORBIDDEN: "ASSIGNMENT_CLASS_FORBIDDEN",
  ASSIGNMENT_INVALID_STATUS_TRANSITION: "ASSIGNMENT_INVALID_STATUS_TRANSITION",

  // Attendance — session lifecycle, timetable tie, and record management.
  ATTENDANCE_SESSION_NOT_FOUND: "ATTENDANCE_SESSION_NOT_FOUND",
  ATTENDANCE_SESSION_DUPLICATE: "ATTENDANCE_SESSION_DUPLICATE",
  ATTENDANCE_NO_TIMETABLE_SLOT: "ATTENDANCE_NO_TIMETABLE_SLOT",
  ATTENDANCE_INVALID_STATUS_TRANSITION: "ATTENDANCE_INVALID_STATUS_TRANSITION",
  ATTENDANCE_RECORD_FORBIDDEN: "ATTENDANCE_RECORD_FORBIDDEN",
  ATTENDANCE_SESSION_NOT_OPEN: "ATTENDANCE_SESSION_NOT_OPEN",
  ATTENDANCE_STUDENT_NOT_IN_CLASS: "ATTENDANCE_STUDENT_NOT_IN_CLASS",
  ATTENDANCE_BATCH_TOO_LARGE: "ATTENDANCE_BATCH_TOO_LARGE",

  // Attendance corrections — window, correctability, and no-op guards (ST-109).
  ATTENDANCE_RECORD_NOT_FOUND: "ATTENDANCE_RECORD_NOT_FOUND",
  ATTENDANCE_CORRECTION_WINDOW_EXPIRED: "ATTENDANCE_CORRECTION_WINDOW_EXPIRED",
  ATTENDANCE_CORRECTION_NOT_CORRECTABLE: "ATTENDANCE_CORRECTION_NOT_CORRECTABLE",
  ATTENDANCE_CORRECTION_NO_CHANGE: "ATTENDANCE_CORRECTION_NO_CHANGE",
  ATTENDANCE_REPORT_RESOURCE_NOT_FOUND: "ATTENDANCE_REPORT_RESOURCE_NOT_FOUND",
  ATTENDANCE_EXPORT_NOT_FOUND: "ATTENDANCE_EXPORT_NOT_FOUND",
  ATTENDANCE_EXPORT_UNAVAILABLE: "ATTENDANCE_EXPORT_UNAVAILABLE",

  // Audit explorer (ST-046x) — async audit-log CSV export lifecycle.
  AUDIT_LOG_EXPORT_NOT_FOUND: "AUDIT_LOG_EXPORT_NOT_FOUND",
  AUDIT_LOG_EXPORT_UNAVAILABLE: "AUDIT_LOG_EXPORT_UNAVAILABLE",

  // Submissions — hand-in window, enrollment scope, and grading state (ST-104).
  SUBMISSION_NOT_FOUND: "SUBMISSION_NOT_FOUND",
  SUBMISSION_FORBIDDEN: "SUBMISSION_FORBIDDEN",
  SUBMISSION_NOT_ENROLLED: "SUBMISSION_NOT_ENROLLED",
  SUBMISSION_WINDOW_CLOSED: "SUBMISSION_WINDOW_CLOSED",
  SUBMISSION_ALREADY_GRADED: "SUBMISSION_ALREADY_GRADED",
  SUBMISSION_INVALID_STATE: "SUBMISSION_INVALID_STATE",
  SUBMISSION_SCORE_EXCEEDS_MAX: "SUBMISSION_SCORE_EXCEEDS_MAX",

  // Object storage — pre-signed URL generation and tenant-prefix enforcement.
  STORAGE_KEY_FORBIDDEN: "STORAGE_KEY_FORBIDDEN",
  STORAGE_OBJECT_NOT_FOUND: "STORAGE_OBJECT_NOT_FOUND",
  STORAGE_NOT_CONFIGURED: "STORAGE_NOT_CONFIGURED",
  // The object's server-computed SHA-256 did not match the checksum the client supplied at confirm.
  STORAGE_CHECKSUM_MISMATCH: "STORAGE_CHECKSUM_MISMATCH",
  // The tenant's storage usage is at its plan's cap; new uploads are blocked.
  STORAGE_QUOTA_EXCEEDED: "STORAGE_QUOTA_EXCEEDED",

  // Materials — upload, ingestion, and AI visibility.
  MATERIAL_NOT_FOUND: "MATERIAL_NOT_FOUND",
  MATERIAL_STORAGE_CONFIRM_FAILED: "MATERIAL_STORAGE_CONFIRM_FAILED",
  MATERIAL_INGEST_IN_PROGRESS: "MATERIAL_INGEST_IN_PROGRESS",

  // Gradebook configuration — category weights and scheme versioning (ST-112).
  INVALID_GRADEBOOK_WEIGHT_TOTAL: "INVALID_GRADEBOOK_WEIGHT_TOTAL",
  GRADEBOOK_NOT_FOUND: "GRADEBOOK_NOT_FOUND",
  GRADING_SCHEME_NOT_FOUND: "GRADING_SCHEME_NOT_FOUND",
  GRADING_SCHEME_IMMUTABLE: "GRADING_SCHEME_IMMUTABLE",
  ASSESSMENT_CATEGORY_NOT_FOUND: "ASSESSMENT_CATEGORY_NOT_FOUND",

  // Grade entry — grade submissions and grade records (ST-113).
  GRADE_SUBMISSION_NOT_FOUND: "GRADE_SUBMISSION_NOT_FOUND",
  GRADE_SHEET_ITEM_NOT_FOUND: "GRADE_SHEET_ITEM_NOT_FOUND",
  GRADE_CONCURRENT_EDIT: "GRADE_CONCURRENT_EDIT",
  GRADE_SCORE_EXCEEDS_MAX: "GRADE_SCORE_EXCEEDS_MAX",
  GRADE_INVALID_STATUS_TRANSITION: "GRADE_INVALID_STATUS_TRANSITION",

  // Discipline — incident and action lifecycle.
  DISCIPLINE_INCIDENT_NOT_FOUND: "DISCIPLINE_INCIDENT_NOT_FOUND",
  DISCIPLINE_INCIDENT_INVALID_STATUS_TRANSITION: "DISCIPLINE_INCIDENT_INVALID_STATUS_TRANSITION",
  DISCIPLINE_INCIDENT_CANNOT_RESOLVE: "DISCIPLINE_INCIDENT_CANNOT_RESOLVE",
  DISCIPLINE_INCIDENT_PARENT_VISIBILITY_DISABLED: "DISCIPLINE_INCIDENT_PARENT_VISIBILITY_DISABLED",
  DISCIPLINE_ACTION_NOT_FOUND: "DISCIPLINE_ACTION_NOT_FOUND",
  DISCIPLINE_ACTION_INVALID_STATUS_TRANSITION: "DISCIPLINE_ACTION_INVALID_STATUS_TRANSITION",

  // Teacher evaluations — lifecycle and visibility.
  EVALUATION_NOT_FOUND: "EVALUATION_NOT_FOUND",
  EVALUATION_INVALID_STATUS_TRANSITION: "EVALUATION_INVALID_STATUS_TRANSITION",
  EVALUATION_ALREADY_SHARED: "EVALUATION_ALREADY_SHARED",
  EVALUATION_NOT_SHARED: "EVALUATION_NOT_SHARED",
  EVALUATION_TEMPLATE_NOT_FOUND: "EVALUATION_TEMPLATE_NOT_FOUND",
  EVALUATION_SCORE_NOT_FOUND: "EVALUATION_SCORE_NOT_FOUND",

  // Stripe billing gateway (ST-xxx).
  STRIPE_NOT_CONFIGURED: "STRIPE_NOT_CONFIGURED",
  STRIPE_API_ERROR: "STRIPE_API_ERROR",
  STRIPE_WEBHOOK_INVALID: "STRIPE_WEBHOOK_INVALID",
  STRIPE_PRICE_SYNC_FAILED: "STRIPE_PRICE_SYNC_FAILED",
  STRIPE_LIVE_KEY_IN_DEV: "STRIPE_LIVE_KEY_IN_DEV",

  // Billing — subscription lifecycle.
  SUBSCRIPTION_NOT_FOUND: "SUBSCRIPTION_NOT_FOUND",
  SUBSCRIPTION_CHECKOUT_FAILED: "SUBSCRIPTION_CHECKOUT_FAILED",
  AI_SUBSCRIPTION_SCHOOL_NOT_ACTIVE: "AI_SUBSCRIPTION_SCHOOL_NOT_ACTIVE",

  // AI quota gate (ST-155). The gate answers with one distinct code per stage of the decision flow
  // -- school active, AI add-on active, quota available -- so a client can branch on exactly why a
  // request was refused: reactivate to fix 403, renew the add-on to fix 402, wait for the budget
  // reset to fix 429. AI_QUOTA_UNAVAILABLE is the fail-closed arm: quota could not be verified (for
  // example the entitlement cache predates the period fields), and the safe answer is to retry.
  AI_SCHOOL_INACTIVE: "AI_SCHOOL_INACTIVE",
  AI_SUBSCRIPTION_INACTIVE: "AI_SUBSCRIPTION_INACTIVE",
  AI_QUOTA_EXCEEDED: "AI_QUOTA_EXCEEDED",
  AI_QUOTA_UNAVAILABLE: "AI_QUOTA_UNAVAILABLE",

  // LLM gateway (ST-164). The generate route answers with one of three provider-stage codes:
  // AI_LLM_DISABLED when the kill switch is off (the feature is deliberately absent, not broken);
  // AI_LLM_UNAVAILABLE when the provider or the network around it is failing (transient -- retry,
  // honoring Retry-After); AI_LLM_REQUEST_REJECTED when the provider answered but refused the
  // request itself (non-transient 4xx -- retrying would repeat the rejection).
  AI_LLM_DISABLED: "AI_LLM_DISABLED",
  AI_LLM_UNAVAILABLE: "AI_LLM_UNAVAILABLE",
  AI_LLM_REQUEST_REJECTED: "AI_LLM_REQUEST_REJECTED",

  // Ask AI streaming endpoint (ST-165).
  AI_CONVERSATION_NOT_FOUND: "AI_CONVERSATION_NOT_FOUND",
  // Not an HTTP status -- this is the refusal path's SSE payload message, resolved through the same
  // localization catalog as every coded error so the client-facing text stays translated.
  AI_ASK_INSUFFICIENT_GROUNDING: "AI_ASK_INSUFFICIENT_GROUNDING",

  // Quiz generation and grading (ST-167). AI_QUIZ_GENERATION_FAILED is the model-output-stage
  // counterpart to AI_LLM_UNAVAILABLE above: the provider answered, but its JSON did not validate
  // against the quiz schema (malformed options, or a citation the model invented) -- a client can
  // retry the same request. AI_QUIZ_NOT_FOUND covers the grading endpoint's quiz lookup, on the same
  // terms AI_CONVERSATION_NOT_FOUND covers Ask AI's.
  AI_QUIZ_GENERATION_FAILED: "AI_QUIZ_GENERATION_FAILED",
  AI_QUIZ_NOT_FOUND: "AI_QUIZ_NOT_FOUND",

  // Flashcard deck generation and spaced-repetition reviews (ST-168). AI_FLASHCARD_GENERATION_FAILED
  // is the model-output-stage counterpart to AI_QUIZ_GENERATION_FAILED: the provider answered, but
  // its JSON did not validate against the flashcard schema -- a client can retry the same request.
  // AI_FLASHCARD_DECK_NOT_FOUND covers the review endpoints' deck lookup, on the same terms
  // AI_QUIZ_NOT_FOUND covers quiz grading's.
  AI_FLASHCARD_GENERATION_FAILED: "AI_FLASHCARD_GENERATION_FAILED",
  AI_FLASHCARD_DECK_NOT_FOUND: "AI_FLASHCARD_DECK_NOT_FOUND",

  // Key-concept extraction (ST-169). AI_CONCEPTS_GENERATION_FAILED is the model-output-stage
  // counterpart to the quiz/flashcard generation failures: the provider answered, but its JSON did
  // not validate against the concepts schema, cited a source it was never given, or named a concept
  // that the grounding validator could not tie to the corpus -- a client can retry the same request.
  AI_CONCEPTS_GENERATION_FAILED: "AI_CONCEPTS_GENERATION_FAILED",

  // Simplified explanations (ST-170). AI_EXPLAIN_GENERATION_FAILED is the model-output-stage
  // counterpart to the concepts failure above: the provider answered, but the rewrite came back
  // empty or the grounding validator could not tie every sentence back to the retrieved passage --
  // a client can retry the same request.
  AI_EXPLAIN_GENERATION_FAILED: "AI_EXPLAIN_GENERATION_FAILED",

  // Exam mode (ST-171). Generation runs in a worker, not the request path, so
  // AI_EXAM_GENERATION_FAILED is never thrown from an HTTP handler -- it is the reason string the
  // GET status endpoint reports once a session's status has settled to `failed` (the same
  // model-output-stage meaning AI_QUIZ_GENERATION_FAILED has for quiz's synchronous path).
  // AI_EXAM_NOT_FOUND covers a session lookup, scoped to school AND student on the same terms
  // AI_QUIZ_NOT_FOUND is. AI_EXAM_INVALID_STATE is start/submit called from a session status that
  // does not allow it (e.g. submit before start, start twice). AI_EXAM_EXPIRED is the
  // acceptance-criterion timer enforcement: submit refused because `now() > expires_at`.
  // AI_EXAM_GENERATION_UNAVAILABLE is create refused because the generation queue or its Redis
  // connection is not configured, on the same terms FINANCE_REPORT_EXPORT_UNAVAILABLE is.
  AI_EXAM_GENERATION_FAILED: "AI_EXAM_GENERATION_FAILED",
  AI_EXAM_NOT_FOUND: "AI_EXAM_NOT_FOUND",
  AI_EXAM_INVALID_STATE: "AI_EXAM_INVALID_STATE",
  AI_EXAM_EXPIRED: "AI_EXAM_EXPIRED",
  AI_EXAM_GENERATION_UNAVAILABLE: "AI_EXAM_GENERATION_UNAVAILABLE",

  // Billing portal (ST-137): the cancellation-flow guards. The first two are distinct from each
  // other because a client acts differently -- one means "nothing to do", the other "cancel first".
  SUBSCRIPTION_ALREADY_CANCELED: "SUBSCRIPTION_ALREADY_CANCELED",
  SUBSCRIPTION_CANCELLATION_NOT_PENDING: "SUBSCRIPTION_CANCELLATION_NOT_PENDING",
  SUBSCRIPTION_NOT_LINKED_TO_PROVIDER: "SUBSCRIPTION_NOT_LINKED_TO_PROVIDER",

  // Uncategorized server-side failure.
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
