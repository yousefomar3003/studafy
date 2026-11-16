/**
 * QA-030: the raw LLM gateway is not reachable.
 *
 * `POST /api/ai/students/{studentId}/generate` passed the caller's `prompt` and `system` (8k
 * characters each) straight to the provider, with no moderation and no safety prompt, and let the
 * caller pick the `feature` -- and with it the large, expensive model. A minor got an unrestricted
 * general-purpose LLM. No web or mobile client calls it (every product feature has its own
 * moderated route), so the API no longer mounts it; the module and its unit tests remain for a
 * future, staff-only use.
 */

// Imported before src/middleware -- see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { buildOpenApiDocument } from "../../src/openapi/document";

describe("raw LLM gateway (QA-030)", () => {
  test("the published API does not offer it", async () => {
    const document = await buildOpenApiDocument();
    expect(Object.keys(document.paths ?? {})).not.toContain(
      "/api/ai/students/{studentId}/generate",
    );
  });
});
