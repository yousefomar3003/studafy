import { ERROR_CODES } from "@studafy/constants";
import { problemDetailsSchema } from "@studafy/shared-schemas";
import { HTTPException } from "hono/http-exception";
import { z, ZodError } from "zod";

import type { Logger } from "./logger";
import type { AppEnv } from "./request-context";
import type { ErrorCode } from "@studafy/constants";
import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * The single error envelope for this API: RFC 9457 problem details, plus request_id — the one
 * extension member (§3.2) that ties a failed response to its log lines and to the audit row it
 * produced. See docs/architecture/SAD_28_logging_conventions.md.
 */

const PROBLEM_CONTENT_TYPE = "application/problem+json";
/** RFC 9457 §3.1: the default when there is no more specific type than the status code itself. */
const BLANK_TYPE = "about:blank";

export const apiProblemSchema = problemDetailsSchema.extend({ request_id: z.uuid() });
export type ApiProblem = z.infer<typeof apiProblemSchema>;

// Maps rather than object literals: a computed index into an object trips
// eslint-plugin-security's detect-object-injection, and a Map is the honest structure for a lookup
// keyed by a runtime number anyway.
const STATUS_TITLES = new Map<number, string>([
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [409, "Conflict"],
  [429, "Too Many Requests"],
  [500, "Internal Server Error"],
]);

// Error codes are never redeclared here — @studafy/constants is the single source of truth.
const STATUS_ERROR_CODES = new Map<number, ErrorCode>([
  [400, ERROR_CODES.VALIDATION_FAILED],
  // Provisional: nothing in this repo authenticates yet, so nothing produces a 401. The ticket that
  // adds auth should throw the specific code it owns (AUTH_TOKEN_EXPIRED, AUTH_INVALID_CREDENTIALS)
  // rather than rely on this status-derived fallback.
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
  if (error instanceof HTTPException) {
    const code = STATUS_ERROR_CODES.get(error.status) ?? ERROR_CODES.INTERNAL_ERROR;
    // An HTTPException message is authored in this codebase, never by a client or a driver, so a
    // 4xx message is safe to echo. A 5xx one is still ours to withhold: it may name an internal
    // dependency, host, or query.
    return error.status >= 500 || error.message === ""
      ? { status: error.status, code }
      : { status: error.status, code, detail: error.message };
  }

  if (error instanceof ZodError) {
    // Reached only via request-input validation: nothing in a handler should be parsing
    // untrusted-shape data (a DB row, say) in the request path. The full error is on the log line
    // regardless of the status chosen here.
    return { status: 400, code: ERROR_CODES.VALIDATION_FAILED, detail: z.prettifyError(error) };
  }

  // Everything else. Nothing from the error reaches the body — not the message, not the stack, not
  // the cause, and not the failing query and bound parameters postgres.js hangs off its errors. All
  // of it goes to the log line, which is the operator's copy. The client gets request_id: that is
  // the handle, and it is enough to find everything above.
  return { status: 500, code: ERROR_CODES.INTERNAL_ERROR };
}

function buildProblem(
  status: ContentfulStatusCode,
  code: ErrorCode,
  requestId: string,
  detail?: string,
): ApiProblem {
  return {
    // Set explicitly: problemDetailsSchema declares .default("about:blank"), but a Zod default
    // applies when parsing, not when constructing — the inferred output type requires `type`.
    type: BLANK_TYPE,
    title: STATUS_TITLES.get(status) ?? "Error",
    status,
    ...(detail === undefined ? {} : { detail }),
    code,
    request_id: requestId,
  };
}

/**
 * Maps any thrown error to a problem+json response and logs it.
 *
 * Note the split this enforces: the log line is the operator's record and carries the whole error;
 * the body is the client's and carries only a status, a code, and the request id joining the two.
 */
export function problemErrorHandler(rootLogger: Logger): ErrorHandler<AppEnv> {
  return (error, c) => {
    // Both fallbacks cover one case: an error thrown above requestContext in the chain, before
    // either variable was set. Inside it, they are always present.
    const requestId = c.get("requestId") ?? crypto.randomUUID();
    const log = c.get("log") ?? rootLogger.child({ request_id: requestId });

    const { status, code, detail } = mapError(error);

    // 5xx is our failure, 4xx is the caller's; both carry the serialized error, only the severity
    // differs. Detaching the method is safe — these are closures, not `this`-bound.
    const emit = status >= 500 ? log.error : log.warn;
    emit({ err: error, status, code }, "request failed");

    // This handler must never throw: Hono calls it from inside a catch block, so a throw here
    // escapes to the next dispatch frame's catch, which calls onError again. Hence no .parse() —
    // apiProblemSchema is the compile-time type and the test oracle, not a runtime step.
    return c.body(JSON.stringify(buildProblem(status, code, requestId, detail)), status, {
      // c.body, not c.json: c.json hard-codes application/json. No charset parameter — RFC 9457
      // defines none, and RFC 8259 already fixes JSON as UTF-8.
      "content-type": PROBLEM_CONTENT_TYPE,
    });
  };
}
