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
 * Turn a request URL's query string into a loggable object, replacing credential values with
 * `[REDACTED]`. The key stays so a reader can still see which parameters the caller sent.
 */
export function sanitizeQueryParams(params: URLSearchParams): Record<string, string> {
  return Object.fromEntries(
    [...params].map(([key, value]) => [
      key,
      SENSITIVE_QUERY_KEY.test(key) ? REDACTED_SEGMENT : value,
    ]),
  );
}
