import { ERROR_CODES } from "@studafy/constants";
import { problemDetailsSchema } from "@studafy/shared-schemas";
import { HTTPException } from "hono/http-exception";
import { z, ZodError } from "zod";

import { AuthException } from "./jwtAuth";
import { getLocalizedMessage } from "./locale";

import type { Logger } from "../logger";
import type { SupportedLocale } from "./locale";
import type { AppEnv } from "./requestId";
import type { ErrorCode } from "@studafy/constants";
import type { ErrorHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * RFC 9457 Problem Details error handler with locale support.
 *
 * Maps typed error codes from @studafy/constants to HTTP status codes and returns
 * localized error messages based on the Accept-Language header.
 *
 * The error envelope contains:
 * - type: "about:blank" (RFC 9457 §3.1)
 * - title: Human-readable status description
 * - status: HTTP status code
 * - detail: Localized error message (optional, only for 4xx)
 * - code: Machine-readable error code from @studafy/constants
 * - request_id: UUID linking to log lines and audit trail
 *
 * Security: 5xx errors never leak internal details to the client. Only the error code
 * and request_id are returned. Full error details are logged server-side.
 */

const PROBLEM_CONTENT_TYPE = "application/problem+json";
const BLANK_TYPE = "about:blank";

export const apiProblemSchema = problemDetailsSchema.extend({ request_id: z.uuid() });
export type ApiProblem = z.infer<typeof apiProblemSchema>;

const STATUS_TITLES = new Map<number, string>([
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [409, "Conflict"],
  [429, "Too Many Requests"],
  [500, "Internal Server Error"],
  [503, "Service Unavailable"],
]);

const STATUS_ERROR_CODES = new Map<number, ErrorCode>([
  [400, ERROR_CODES.VALIDATION_FAILED],
  [401, ERROR_CODES.AUTH_TOKEN_INVALID],
  [403, ERROR_CODES.AUTHZ_FORBIDDEN],
  [404, ERROR_CODES.RESOURCE_NOT_FOUND],
  [409, ERROR_CODES.CONFLICT_STATE_MISMATCH],
  [429, ERROR_CODES.RATE_LIMIT_EXCEEDED],
]);

interface MappedError {
  status: ContentfulStatusCode;
  code: ErrorCode;
  detail?: string;
}

function mapError(error: unknown): MappedError {
  // Checked before the HTTPException branch it extends: authentication carries a code the status
  // alone cannot express — 401 maps to AUTH_TOKEN_INVALID by default, which would misreport an
  // expired token and send a client that only needs to refresh into a re-login loop.
  if (error instanceof AuthException) {
    return { status: 401, code: error.code, detail: error.message };
  }

  if (error instanceof HTTPException) {
    const code = STATUS_ERROR_CODES.get(error.status) ?? ERROR_CODES.INTERNAL_ERROR;
    // 4xx messages are safe to echo (authored in this codebase). 5xx messages may expose
    // internal dependencies and are withheld.
    return error.status >= 500 || error.message === ""
      ? { status: error.status, code }
      : { status: error.status, code, detail: error.message };
  }

  if (error instanceof ZodError) {
    return { status: 400, code: ERROR_CODES.VALIDATION_FAILED, detail: z.prettifyError(error) };
  }

  // Unknown errors: nothing reaches the client. Full details are logged.
  return { status: 500, code: ERROR_CODES.INTERNAL_ERROR };
}

function buildProblem(
  status: ContentfulStatusCode,
  code: ErrorCode,
  requestId: string,
  detail?: string,
  instance?: string,
): ApiProblem {
  return {
    type: BLANK_TYPE,
    title: STATUS_TITLES.get(status) ?? "Error",
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(instance === undefined ? {} : { instance }),
    code,
    request_id: requestId,
  };
}

/**
 * Global error handler middleware.
 *
 * Intercepts all thrown errors and returns RFC 9457 problem+json responses with
 * localized messages based on the Accept-Language header.
 *
 * @param rootLogger - Logger instance for error logging
 * @returns Hono ErrorHandler
 *
 * @example
 * ```typescript
 * app.onError(errorHandlerMiddleware(logger));
 * ```
 */
export function errorHandlerMiddleware(rootLogger: Logger): ErrorHandler<AppEnv> {
  return (error, c) => {
    const requestId = c.get("requestId") ?? crypto.randomUUID();
    const locale = c.get("locale") ?? "en";
    const log = c.get("log") ?? rootLogger.child({ request_id: requestId });

    const { status, code, detail: rawDetail } = mapError(error);

    // 5xx errors: never include detail (security best practice - may expose internals)
    // 4xx errors: include localized message if no custom detail provided
    const detail =
      status >= 500
        ? undefined
        : (rawDetail ?? getLocalizedMessage(code, locale as SupportedLocale));

    // Log the error with full details (never exposed to client)
    const emit = status >= 500 ? log.error : log.warn;
    emit({ err: error, status, code, locale }, "request failed");

    // Build the RFC 9457 response
    const problem = buildProblem(status, code, requestId, detail);

    return c.body(JSON.stringify(problem), status, {
      // c.body, not c.json: c.json hard-codes application/json. No charset parameter — RFC 9457
      // defines none, and RFC 8259 already fixes JSON as UTF-8.
      "content-type": PROBLEM_CONTENT_TYPE,
      // RFC 6750 §3 requires a challenge on a 401 from a bearer-protected resource. It is added
      // here rather than in jwtAuth.ts because a header staged on the context is discarded when a
      // middleware throws — this is the frame where the 401 response is actually constructed.
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    });
  };
}

/**
 * Not-found handler for unmatched routes.
 *
 * Returns the same RFC 9457 envelope as error responses, so clients don't need to
 * special-case 404 responses. Includes a localized message when Accept-Language is set.
 */
export const notFoundHandler: NotFoundHandler<AppEnv> = (c) => {
  const requestId = c.get("requestId") ?? crypto.randomUUID();
  const locale = c.get("locale") ?? "en";
  const path = c.req.path;

  const localizedMessage = getLocalizedMessage(
    ERROR_CODES.RESOURCE_NOT_FOUND,
    locale as SupportedLocale,
  );

  return c.body(
    JSON.stringify(
      buildProblem(
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        requestId,
        `${localizedMessage}. The requested path ${path} does not exist.`,
        path,
      ),
    ),
    404,
    { "content-type": PROBLEM_CONTENT_TYPE },
  );
};
