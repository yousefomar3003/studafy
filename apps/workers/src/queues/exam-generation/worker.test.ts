// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { processExamGeneration } from "./worker";

import type { Job } from "bullmq";

/**
 * Only the DB-free guard is unit-tested here, the same posture
 * `attendance-export.worker.test.ts` takes toward its own worker: everything that touches Postgres
 * or the LLM is proven at the route level (`exam-routes.test.ts`, a fake `Database`) and by
 * `schema.test.ts` / `parser.test.ts` / `anthropic-client.test.ts`'s pure-function coverage, mirroring
 * how quiz generation's own `materials.ts` / `persistence.ts` have no dedicated test files either.
 */
describe("processExamGeneration", () => {
  test("returns invalid without touching the database when job data fails validation", async () => {
    const job = { data: { examSessionId: "not-a-uuid" } } as unknown as Job;

    const result = await processExamGeneration(job, {
      databaseUrl: "postgres://unreachable-host-should-never-be-dialed/db",
      anthropic: null,
    });

    expect(result).toEqual({ processed: false, reason: "invalid job data" });
  });
});
