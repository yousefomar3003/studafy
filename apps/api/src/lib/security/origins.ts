/**
 * Origin validation utilities for CORS.
 *
 * Provides strict origin matching without wildcards when credentials are used.
 */

export interface OriginValidationResult {
  allowed: boolean;
  origin?: string;
}

/**
 * Validate if an origin is in the allowed list.
 *
 * @param origin - The origin to validate
 * @param allowedOrigins - List of allowed origins
 * @returns Validation result
 */
export function validateOrigin(
  origin: string | undefined,
  allowedOrigins: string[],
): OriginValidationResult {
  if (!origin) {
    return { allowed: false };
  }

  const normalizedOrigin = normalizeOrigin(origin);
  const isAllowed = allowedOrigins.some((allowed) => normalizeOrigin(allowed) === normalizedOrigin);

  return {
    allowed: isAllowed,
    origin: isAllowed ? normalizedOrigin : undefined,
  };
}

/**
 * Normalize an origin by removing trailing slashes and lowercasing.
 */
function normalizeOrigin(origin: string): string {
  return origin.toLowerCase().replace(/\/$/, "");
}

/**
 * Check if origin is a null origin (from sandboxed iframes, data: URLs, etc.)
 */
export function isNullOrigin(origin: string | null): boolean {
  return origin === "null" || origin === null;
}
