import { z } from "@hono/zod-openapi";

import { apiProblemOpenApiSchema } from "./components";

import type { RouteConfig } from "@hono/zod-openapi";

/**
 * The single sanctioned way to build a route's `responses` map (ST-060).
 *
 * Two contract-wide requirements are welded on here rather than restated per route: every response
 * carries the X-Request-Id header, and every failure is an RFC 9457 problem+json body. A route
 * author picks its success shapes and which failures it can produce; it cannot forget either
 * requirement, because it never writes them.
 */

/**
 * The non-$ref arm of a zod-to-openapi response entry, recovered from the public RouteConfig rather
 * than imported from @asteasolutions/zod-to-openapi — that package is a transitive dependency of
 * @hono/zod-openapi, not one we declare, so importing from it directly would be a phantom dependency.
 */
type ResponseConfig = Exclude<RouteConfig["responses"][string], { $ref: string }>;

/**
 * Exactly the statuses errorHandlerMiddleware can emit: the intersection of its STATUS_TITLES and
 * STATUS_ERROR_CODES maps, plus the 500 that mapError falls back to for unknown errors. Declaring a
 * problem response outside this set would document a response no code path can produce.
 */
export const PROBLEM_STATUSES = [400, 401, 403, 404, 409, 429, 500] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

/**
 * requestIdMiddleware stamps this after next(), which is why it is on every response and not just
 * the successful ones — including responses built by app.onError, which unwind back through that
 * line. Declared `required` because it is unconditional.
 */
export const requestIdHeaders = z.object({
  "X-Request-Id": z.uuid().openapi({
    description:
      "Server-generated correlation id, present on every response. Never read from the request. " +
      "Matches the `request_id` member of a problem+json body and the request_id in server logs.",
    example: "0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12",
  }),
});

export interface OkResponse<TSchema extends z.ZodType> {
  readonly description: string;
  readonly schema: TSchema;
}

/**
 * The conditional is what lets this be mapped over `keyof TOk`: a mapped type cannot prove `TOk[K]`
 * satisfies a constraint on its own, so the check is done inline and the false arm is unreachable
 * given TOk's own constraint.
 */
type OkEntry<T> =
  T extends OkResponse<infer TSchema>
    ? {
        description: string;
        headers: typeof requestIdHeaders;
        content: { "application/json": { schema: TSchema } };
      }
    : never;

interface ProblemEntry {
  description: string;
  headers: typeof requestIdHeaders;
  content: { "application/problem+json": { schema: typeof apiProblemOpenApiSchema } };
}

/** Prose for each problem status, so the reference site explains a failure rather than naming it. */
const PROBLEM_DESCRIPTIONS: Record<ProblemStatus, string> = {
  400: "The request was malformed or failed schema validation.",
  401: "Authentication is missing or invalid.",
  403: "Authenticated, but not permitted to perform this operation.",
  404: "No such resource, or it is not visible to this tenant.",
  409: "The request conflicts with the current state of the resource.",
  429: "Rate limit exceeded. Back off and retry.",
  500: "Unexpected server error. The body carries no detail; correlate via request_id.",
};

/**
 * Compose a complete `responses` map: the route's own success shapes, an RFC 9457 problem+json entry
 * for every failure it can produce, and X-Request-Id on all of them.
 *
 * Success entries are a map rather than a single shape because a route can succeed in more than one
 * way that is not an error — /readyz answers 503 with a normal JSON body when draining, which is not
 * a problem+json and is deliberately not in PROBLEM_STATUSES.
 *
 * The `const` type parameters are load-bearing: they preserve each concrete schema through to
 * RouteConfigToTypedResponse, so `c.json(body, 200)` is still checked against what the route
 * declared. Widening the return to RouteConfig["responses"] would erase it and silently turn off
 * handler return-type checking.
 *
 * The types make forgetting the header awkward; they cannot make it impossible, because a
 * hand-written object literal still satisfies RouteConfig. openapi/document.test.ts walks the
 * generated document and fails on any response missing it — that test, not this signature, is the
 * guarantee.
 */
export function standardResponses<
  const TOk extends Readonly<Record<number, OkResponse<z.ZodType>>>,
  const TProblems extends readonly ProblemStatus[],
>(
  ok: TOk,
  problems: TProblems,
): { [K in keyof TOk]: OkEntry<TOk[K]> } & Record<TProblems[number], ProblemEntry> {
  const responses: Record<number, ResponseConfig> = {};

  for (const [status, entry] of Object.entries(ok)) {
    responses[Number(status)] = {
      description: entry.description,
      headers: requestIdHeaders,
      content: { "application/json": { schema: entry.schema } },
    };
  }

  for (const status of problems) {
    responses[status] = {
      description: PROBLEM_DESCRIPTIONS[status],
      headers: requestIdHeaders,
      content: { "application/problem+json": { schema: apiProblemOpenApiSchema } },
    };
  }

  return responses as { [K in keyof TOk]: OkEntry<TOk[K]> } & Record<
    TProblems[number],
    ProblemEntry
  >;
}
