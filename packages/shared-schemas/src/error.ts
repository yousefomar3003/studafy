import { ERROR_CODES, type ErrorCode } from "@studafy/constants";
import { z } from "zod";

/**
 * `application/problem+json` error envelope (RFC 9457). The machine-readable `code` reuses
 * ERROR_CODES from @studafy/constants — error codes are never redeclared here. See
 * docs/schema-conventions.md.
 */

/** One of the canonical error codes owned by @studafy/constants. */
export const errorCodeSchema = z.enum(ERROR_CODES);

// `ErrorCode` is single-sourced from @studafy/constants (not re-derived here). The guard below
// fails to compile if the runtime schema and the canonical union ever drift apart — e.g. if
// Zod's inference widens or a code is added without `as const` — so lockstep is enforced by tsc.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _errorCodeInSync: Equals<z.infer<typeof errorCodeSchema>, ErrorCode> = true;

export type { ErrorCode };

/**
 * RFC 9457 problem details. `type` defaults to "about:blank" per the spec; `status` is the
 * HTTP status code; `code` is our own extension member tying the problem to a constants error
 * code.
 */
export const problemDetailsSchema = z.object({
  type: z.string().default("about:blank"),
  title: z.string(),
  status: z.number().int().min(100).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: errorCodeSchema,
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
