const REDACTED_SEGMENT = "[REDACTED]";

/**
 * Replace bearer credentials embedded in known route paths before they reach logs, telemetry, or
 * problem responses. Routing and authentication continue to use the original path.
 */
export function sanitizeSensitivePath(path: string): string {
  const segments = path.split("/");

  if (
    segments.length >= 6 &&
    segments[0] === "" &&
    segments[1] === "api" &&
    segments[2] === "auth" &&
    segments[3] === "invitations" &&
    segments[4] !== "" &&
    segments[5] === "verify"
  ) {
    segments[4] = REDACTED_SEGMENT;
    return segments.join("/");
  }

  return path;
}
