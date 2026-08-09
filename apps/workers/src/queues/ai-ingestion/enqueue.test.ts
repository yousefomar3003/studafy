/**
 * Producer-side tests for the ai-ingestion queue (ST-161). Pure: the BullMQ `Queue` is a fake that
 * records the add() call, so no Redis connection is opened.
 */

import { INGESTION_JOB_OPTIONS, JOB_NAMES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { enqueueAiIngestion } from "./enqueue";

import type { Queue } from "bullmq";

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const MATERIAL_ID = "22222222-2222-4222-8222-222222222222";

function fakeQueue(): { queue: Queue; adds: unknown[] } {
  const adds: unknown[] = [];
  const queue = {
    async add(...args: unknown[]) {
      adds.push(args);
    },
  } as unknown as Queue;
  return { queue, adds };
}

describe("enqueueAiIngestion", () => {
  test("adds an ingest-material job carrying the school and material ids", async () => {
    const { queue, adds } = fakeQueue();

    await enqueueAiIngestion(queue, SCHOOL_ID, MATERIAL_ID);

    expect(adds).toHaveLength(1);
    const [name, data, options] = adds[0] as [string, unknown, unknown];
    expect(name).toBe(JOB_NAMES.INGEST_MATERIAL);
    expect(data).toEqual({ version: 1, schoolId: SCHOOL_ID, materialId: MATERIAL_ID });
    // Shares the single source of truth for retry/retention so the scan worker and the API
    // re-enable route cannot drift apart.
    expect(options).toBe(INGESTION_JOB_OPTIONS);
  });
});
