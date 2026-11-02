import { problemDetailsSchema } from "@studafy/shared-schemas";
import { z } from "zod";

import type { ErrorCode } from "@studafy/constants";

/**
 * Typed, catchable client-side representation of an API failure.
 *
 * Every Studafy API error is an RFC 9457 `application/problem+json` document carrying the standard
 * members plus two extensions: `code` (a stable, machine-readable error code) and `request_id` (the
 * server-generated correlation id, also echoed in the `X-Request-Id` response header). This module
 * parses that envelope into an {@link ApiError} that a UI error boundary can catch and inspect —
 * quoting `request_id` to support, branching on `code`, never scraping localized prose.
 */

const PROBLEM_JSON_MEDIA_TYPE = "application/problem+json";
const REQUEST_ID_HEADER = "x-request-id";

/**
 * Client-side view of the problem envelope: the shared RFC 9457 shape reused from
 * {@link @studafy/shared-schemas} plus the API's `request_id` extension. Not redefined here — the
 * base shape is single-sourced. `request_id` is lenient (a non-empty string, parsed optional) so a
 * body that omits it still parses and we fall back to the response header, and a body that carries a
 * non-uuid id is not discarded wholesale.
 */
export const clientProblemSchema = problemDetailsSchema.extend({
  request_id: z.string().min(1).optional(),
});

/** A fully parsed problem+json body. */
export type ClientProblem = z.infer<typeof clientProblemSchema>;

/** The flat, always-present surface an error boundary reads off an {@link ApiError}. */
export interface ApiErrorFields {
  /** HTTP status code of the failing response. */
  readonly status: number;
  /** Short, human-readable summary. Prose — may be localized; branch on {@link code} instead. */
  readonly title: string;
  /** Stable machine-readable error code, or `null` when the body was not a parseable problem. */
  readonly code: ErrorCode | null;
  /** Human-readable explanation. Absent on 5xx by design; `null` when not provided. */
  readonly detail: string | null;
  /** URI reference identifying the specific occurrence (e.g. the request path). */
  readonly instance: string | null;
  /** Problem type URI (`about:blank` when unclassified); `null` when the body did not parse. */
  readonly type: string | null;
  /** Correlation id: the body's `request_id`, else the `X-Request-Id` header, else `null`. */
  readonly request_id: string | null;
  /** The raw parsed problem body, or `null` when the response carried no parseable problem. */
  readonly problem: ClientProblem | null;
}

/** Error thrown by the client for any non-2xx response. Catch with `instanceof ApiError`. */
export class ApiError extends Error implements ApiErrorFields {
  readonly status: number;
  readonly title: string;
  readonly code: ErrorCode | null;
  readonly detail: string | null;
  readonly instance: string | null;
  readonly type: string | null;
  readonly request_id: string | null;
  readonly problem: ClientProblem | null;

  constructor(fields: ApiErrorFields) {
    super(ApiError.messageFor(fields));
    this.name = "ApiError";
    this.status = fields.status;
    this.title = fields.title;
    this.code = fields.code;
    this.detail = fields.detail;
    this.instance = fields.instance;
    this.type = fields.type;
    this.request_id = fields.request_id;
    this.problem = fields.problem;
    // Restore the prototype chain so `instanceof ApiError` holds after transpilation to ES2022.
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  /**
   * Builds an {@link ApiError} from a failed {@link Response}. Reads the body from a clone, so the
   * original response stream is never consumed — this runs inside client middleware that throws
   * before openapi-fetch would otherwise read the body. A body that is not a parseable problem
   * degrades to a generic error without inventing fields.
   */
  static async fromResponse(response: Response): Promise<ApiError> {
    const headerRequestId = response.headers.get(REQUEST_ID_HEADER);
    const contentType = response.headers.get("content-type") ?? "";

    let problem: ClientProblem | null = null;
    if (contentType.includes(PROBLEM_JSON_MEDIA_TYPE) || contentType.includes("application/json")) {
      try {
        const parsed = clientProblemSchema.safeParse(await response.clone().json());
        if (parsed.success) {
          problem = parsed.data;
        }
      } catch {
        // Non-JSON or unreadable body: fall through to the degraded generic error below.
      }
    }

    return new ApiError({
      status: problem?.status ?? response.status,
      title: problem?.title ?? (response.statusText || "Request failed"),
      code: problem?.code ?? null,
      detail: problem?.detail ?? null,
      instance: problem?.instance ?? null,
      type: problem?.type ?? null,
      request_id: problem?.request_id ?? headerRequestId,
      problem,
    });
  }

  private static messageFor(fields: ApiErrorFields): string {
    const base = fields.code ? `${fields.code}: ${fields.title}` : fields.title;
    return fields.request_id ? `${base} (request_id: ${fields.request_id})` : base;
  }
}
