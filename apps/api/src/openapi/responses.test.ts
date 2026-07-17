import { z } from "@hono/zod-openapi";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { PROBLEM_STATUSES, standardResponses } from "./responses";

/**
 * ST-060. Unit-level checks on the composer itself. The document-wide guarantee — that no route
 * anywhere is missing the header or the problem+json envelope — is asserted in document.test.ts by
 * walking the generated artifact; this file only pins the composer's own behaviour.
 */

const okSchema = z.object({ status: z.literal("ok") });

describe("standardResponses", () => {
  test("returns exactly the success and problem statuses it was given", () => {
    const responses = standardResponses(
      { 200: { description: "Fine.", schema: okSchema } },
      [400, 500],
    );

    expect(Object.keys(responses).sort()).toEqual(["200", "400", "500"]);
  });

  test("puts the X-Request-Id header on every response, success and failure alike", () => {
    const responses = standardResponses(
      { 200: { description: "Fine.", schema: okSchema } },
      [401, 500],
    );

    for (const [status, response] of Object.entries(responses)) {
      const headers = (response as { headers: z.ZodObject<{ "X-Request-Id": z.ZodType }> }).headers;

      expect(headers.shape["X-Request-Id"], `status ${status} has no X-Request-Id`).toBeDefined();
    }
  });

  test("gives success entries application/json and problems application/problem+json", () => {
    const responses = standardResponses({ 200: { description: "Fine.", schema: okSchema } }, [400]);

    expect(Object.keys((responses[200] as { content: object }).content)).toEqual([
      "application/json",
    ]);
    expect(Object.keys((responses[400] as { content: object }).content)).toEqual([
      "application/problem+json",
    ]);
  });

  test("supports more than one success status", () => {
    const responses = standardResponses(
      {
        200: { description: "Ready.", schema: okSchema },
        503: { description: "Draining.", schema: z.object({ status: z.literal("shutting_down") }) },
      },
      [500],
    );

    expect(Object.keys(responses).sort()).toEqual(["200", "500", "503"]);
    // 503 is a success shape here, not a problem: draining is an expected state, and the load
    // balancer reads the status code rather than an error envelope.
    expect(Object.keys((responses[503] as { content: object }).content)).toEqual([
      "application/json",
    ]);
  });

  test("describes every problem status it admits", () => {
    const responses = standardResponses({ 200: { description: "Fine.", schema: okSchema } }, [
      ...PROBLEM_STATUSES,
    ]);

    for (const status of PROBLEM_STATUSES) {
      const description = (responses[status] as { description: string }).description;

      expect(description, `status ${status} has no description`).toBeTruthy();
    }
  });
});

describe("PROBLEM_STATUSES", () => {
  // Mirrors STATUS_TITLES/STATUS_ERROR_CODES in middleware/errorHandler.ts, plus the 500 that
  // mapError falls back to. If a status is added there, it belongs here; if one is documented that
  // the handler cannot produce, the document is lying.
  test("is exactly the set errorHandlerMiddleware can emit", () => {
    expect([...PROBLEM_STATUSES]).toEqual([400, 401, 403, 404, 409, 429, 500]);
  });
});
