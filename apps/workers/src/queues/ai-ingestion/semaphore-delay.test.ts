/**
 * QA-064: a school at its ingestion concurrency cap waits its turn instead of failing.
 *
 * Losing the per-school semaphore threw TenantConcurrencyExceededError, which BullMQ counts as a
 * failed attempt: under contention (bulk "enable AI" on a class) five attempts in ~75 seconds ran
 * out and materials ended `failed`, with the uploader notified. A busy semaphore now moves the job
 * back to the delayed set (moveToDelayed + DelayedError), which consumes no attempt.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import postgres from "postgres";

import { runMonitoredJob } from "../../worker";

import { processIngestJob } from "./worker";

import type { TenantSemaphore } from "./semaphore";
import type { QueueDefinition } from "../../registry";
import type { Job } from "bullmq";

const busy: TenantSemaphore = { acquire: async () => null } as unknown as TenantSemaphore;

function fakeJob(attemptsMade = 0) {
  const delayedTo: { at: number; token: string | undefined }[] = [];
  const job = {
    id: "material-1",
    name: "ingest",
    data: {
      version: 1,
      materialId: "00000000-0000-4000-8000-000000000001",
      schoolId: "00000000-0000-4000-8000-000000000002",
    },
    attemptsMade,
    opts: { attempts: 5 },
    moveToDelayed: async (at: number, token?: string) => {
      delayedTo.push({ at, token });
    },
  } as unknown as Job;
  return { job, delayedTo };
}

// Never queried: the semaphore is checked before the material is claimed.
const sql = postgres("postgres://unused@127.0.0.1:1/unused", { max: 1 });
const config = {
  databaseUrl: "postgres://unused@127.0.0.1:1/unused",
  sql,
  semaphore: busy,
  fetchBytes: async () => new Uint8Array(),
};

describe("ingestion under a busy school semaphore (QA-064)", () => {
  test("the job is delayed, not failed, and no attempt is consumed", async () => {
    const { job, delayedTo } = fakeJob();
    const error = await processIngestJob(job, config, "lock-token-1").catch((e: unknown) => e);
    expect((error as Error).name).toBe("DelayedError");
    expect(delayedTo).toHaveLength(1);
    expect(delayedTo[0]!.token).toBe("lock-token-1");
    expect(delayedTo[0]!.at).toBeGreaterThan(Date.now());
  });

  test("a delay is never reported as a failure, even on the last attempt", async () => {
    const reported: unknown[] = [];
    const definition = {
      name: "ai-ingestion",
      processor: (job: Job, token?: string) => processIngestJob(job, config, token),
    } as unknown as QueueDefinition;
    const { job } = fakeJob(4);
    await runMonitoredJob(definition, job, (error) => reported.push(error), "t").catch(
      () => undefined,
    );
    expect(reported).toEqual([]);
  });
});
