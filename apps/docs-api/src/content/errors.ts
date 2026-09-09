import type { Guide } from "./types";

/**
 * Error taxonomy guide (ST-269).
 *
 * Sourced from apps/api/src/problem.ts (the envelope and status→title/code mapping),
 * apps/api/src/openapi/responses.ts (PROBLEM_STATUSES and their prose), and
 * packages/constants/src/errors.ts (ERROR_CODES, the actual enum). The full code list is not
 * hand-copied here — render.ts generates it straight from ERROR_CODES, so it cannot drift from the
 * contract the way a hand-maintained table would.
 */
export const errorsGuide: Guide = {
  slug: "errors",
  navTitle: "Errors",
  title: "Error handling",
  summary:
    "Every failure this API produces is one envelope shape, an RFC 9457 problem+json body with a " +
    "stable machine-readable code. There is no second error format to special-case.",
  sections: [
    {
      heading: "The envelope",
      body: [
        "Any status 4xx/5xx is `Content-Type: application/problem+json`, shaped as " +
          "[RFC 9457](https://datatracker.ietf.org/doc/html/rfc9457) plus one extension member, " +
          "`request_id`, that ties the response to the server log line and audit row it produced:",
      ],
      blocks: [
        {
          language: "json",
          code:
            "{\n" +
            '  "type": "about:blank",\n' +
            '  "title": "Not Found",\n' +
            '  "status": 404,\n' +
            '  "detail": "No such resource, or it is not visible to this tenant.",\n' +
            '  "code": "RESOURCE_NOT_FOUND",\n' +
            '  "request_id": "0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12"\n' +
            "}",
        },
      ],
    },
    {
      heading: "X-Request-Id",
      body: [
        "Every response — success or failure — carries an `X-Request-Id` header, generated " +
          "server-side and never read from the request. It matches a failure body's `request_id` " +
          "and the `request_id` field on the corresponding server log line. When something needs " +
          "investigating, this is the one value to hand to whoever has log access: the body " +
          "deliberately carries no more than a status, a code, and (for 4xx only) a detail string — " +
          "a 5xx's stack, cause, and any failing query are on the log line and never in the " +
          "response.",
      ],
    },
    {
      heading: "`code` is part of the contract",
      body: [
        "`code` is not free text — it is a proper enum in the OpenAPI document, generated from a " +
          "single TypeScript source of truth (`ERROR_CODES` in `@studafy/constants`). Removing a " +
          "code a client might branch on, or narrowing what a response can carry, is a breaking " +
          "change under [the API versioning policy]" +
          "(https://github.com/yousefomar3003/studafy/blob/main/docs/api/api-versioning-policy.md) and is " +
          "caught the same way any other breaking change is: `oasdiff` fails the PR unless it " +
          "carries the `version-bump` label.",
        "That is what makes branching on `code` (rather than parsing `detail`, which is human " +
          "prose and can be reworded without notice) the supported way to handle a specific failure " +
          "programmatically.",
      ],
    },
    {
      heading: "Status classes",
      body: [
        "Every status this API can answer with, and what it means here specifically — not the " +
          "generic HTTP definition:",
      ],
      blocks: [
        {
          language: "text",
          code:
            "400 — The request was malformed or failed schema validation.\n" +
            "401 — Authentication is missing or invalid.\n" +
            "402 — Subscription limit reached. Upgrade your plan to continue.\n" +
            "403 — Authenticated, but not permitted to perform this operation.\n" +
            "404 — No such resource, or it is not visible to this tenant.\n" +
            "409 — The request conflicts with the current state of the resource.\n" +
            "410 — This tenant has been permanently closed.\n" +
            "422 — The resource is valid JSON but lacks required domain data.\n" +
            "429 — Rate limit exceeded. Back off and retry.\n" +
            "500 — Unexpected server error. The body carries no detail; correlate via request_id.\n" +
            "503 — A required service dependency is unavailable.",
        },
      ],
    },
    {
      heading: "Naming convention",
      body: [
        "Codes are `SCREAMING_SNAKE_CASE`, grouped by the domain that raises them: an " +
          "`AUTH_`/`AUTHZ_` prefix for identity/permission failures, a resource-named prefix " +
          "(`SUBMISSION_`, `ATTENDANCE_`, `GRADE_…`) for that resource's lifecycle rules, and so on. " +
          "A code names *why*, and is deliberately more specific than the HTTP status carrying it — " +
          "several different codes commonly share one status (`ERROR_CODES.ts` groups them by " +
          "domain, not by status, for exactly this reason).",
        "A generic status-derived fallback exists (`VALIDATION_FAILED` for a bare 400, " +
          "`RESOURCE_NOT_FOUND` for a bare 404, and so on) for failures that predate a more specific " +
          "code or are truly generic — but a new failure a client needs to distinguish always gets " +
          "its own code rather than reusing one of these.",
      ],
    },
    {
      heading: "Validation failures",
      body: [
        "A 400 from a malformed request body reuses the same envelope; `detail` is the flattened " +
          "Zod error (`z.prettifyError`), naming the offending field(s) rather than only the fact " +
          "that validation failed.",
      ],
    },
  ],
};
