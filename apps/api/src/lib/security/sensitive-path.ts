const REDACTED_SEGMENT = "[REDACTED]";

/**
 * Replace bearer credentials embedded in known route paths before they reach logs, telemetry, or
 * problem responses. Routing and authentication continue to use the original path.
 *
 * Covered prefixes, where the segment after the prefix is the credential:
 *  - `/api/auth/invitations/{token}/…` — verify, activate, and the activation OAuth start/mobile
 *    routes. Every route under this prefix carries the invitation token, so the segment is redacted
 *    for any descendant, matched or not.
 *  - `/api/schools/verify-email/{token}` — the school email-verification link.
 */
export function sanitizeSensitivePath(path: string): string {
  const segments = path.split("/");
  if (segments.length < 5 || segments[0] !== "" || segments[1] !== "api") return path;
  if (segments[4] === "") return path;

  const isInvitation = segments[2] === "auth" && segments[3] === "invitations";
  const isSchoolEmailVerification = segments[2] === "schools" && segments[3] === "verify-email";
  if (!isInvitation && !isSchoolEmailVerification) return path;

  segments[4] = REDACTED_SEGMENT;
  return segments.join("/");
}

/**
 * Query keys whose values are credentials: OAuth `code`/`state`, the Google Play RTDN push `token`,
 * and anything password- or secret-shaped. Matched case-insensitively on the whole key.
 */
const SENSITIVE_QUERY_KEY =
  /^(code|state|token|access_token|refresh_token|id_token|password|secret|client_secret|api_key|key|signature|sig)$/i;

/**
 * Query keys whose *values* may be logged (QA-019 / QA-020): structural parameters only -- ids,
 * paging, enums, dates, flags -- drawn from the API's own query parameters. Everything else keeps
 * its key but loses its value, so free text (`search`, `q`, `filter_value`: a child's name, a
 * parent's email) and any parameter added later are redacted by default rather than by someone
 * remembering to list them.
 */
const LOGGABLE_QUERY_KEYS: ReadonlySet<string> = new Set([
  // paging and shaping
  "limit",
  "offset",
  "cursor",
  "page",
  "startingAfter",
  "sort",
  "order",
  "group_by",
  "format",
  "lang",
  "show",
  "types",
  "interval",
  "scope",
  "kind",
  "filter",
  "filter_column",
  // ids (uuids or system document numbers)
  "academic_year_id",
  "actorId",
  "actor_id",
  "assignment_id",
  "classId",
  "class_id",
  "course_id",
  "finalization_id",
  "gradeLevelId",
  "grade_level_id",
  "invoice_id",
  "lead_teacher_id",
  "mapping_id",
  "scholarship_id",
  "schoolId",
  "sectionId",
  "section_id",
  "source_key",
  "source_year_id",
  "studentId",
  "student_id",
  "student_ids",
  "subject_id",
  "subject_user_id",
  "target_id",
  "target_year_id",
  "teacher_id",
  "termId",
  "term_id",
  "voucher_no",
  "voucher_type",
  "targetTable",
  "target_table",
  // enums and flags
  "action",
  "activity",
  "audience",
  "balance",
  "discard_slots",
  "document_type",
  "evaluation_type",
  "grade_status",
  "include_archived",
  "ingest_status",
  "is_active",
  "issue",
  "link_kind",
  "payment_mode",
  "priority",
  "role",
  "room_type",
  "severity",
  "status",
  "storage",
  "unpaid",
  "unread_only",
  "provider_linked",
  "error",
  // dates and numbers
  "before",
  "created_from",
  "created_to",
  "date_from",
  "date_to",
  "due_date_from",
  "due_date_to",
  "due_from",
  "due_to",
  "end_date",
  "ends_after",
  "expiringWithinDays",
  "from",
  "from_date",
  "issued_from",
  "issued_to",
  "min_children",
  "month",
  "report_date",
  "seatsNearlyFull",
  "session_date",
  "since",
  "start_date",
  "starts_before",
  "to",
  "to_date",
  "year",
]);

/**
 * Turn a request URL's query string into a loggable object. Credential keys and every key not on
 * the allowlist above have their value replaced with `[REDACTED]`; the key stays so a reader can
 * still see which parameters the caller sent.
 */
export function sanitizeQueryParams(params: URLSearchParams): Record<string, string> {
  return Object.fromEntries(
    [...params].map(([key, value]) => [
      key,
      SENSITIVE_QUERY_KEY.test(key) || !LOGGABLE_QUERY_KEYS.has(key) ? REDACTED_SEGMENT : value,
    ]),
  );
}
