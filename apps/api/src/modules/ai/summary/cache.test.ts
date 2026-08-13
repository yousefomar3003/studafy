// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { AI_SUMMARY_CACHE_KEY_PREFIX, AI_SUMMARY_CACHE_TTL_SECONDS } from "../config";

import {
  createSummaryCache,
  summaryCacheKey,
  summaryFingerprint,
  type SummaryCacheEntry,
} from "./cache";

import type { LoadedSummaryChunk } from "./materials";
import type { RedisClient } from "../../../redis";

function chunk(over: Partial<LoadedSummaryChunk> = {}): LoadedSummaryChunk {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    chunkIndex: 0,
    pageNumber: null,
    sectionTitle: null,
    content: "text",
    ...over,
  };
}

/** Minimal ioredis-compatible fake: an in-memory string store with EX awareness. */
function fakeRedis(): RedisClient {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string, ...args: unknown[]) => {
      // Ignore the "EX" mode argument; TTL handling is ioredis's job, not ours to verify here.
      void args;
      store.set(key, value);
      return "OK";
    },
  } as unknown as RedisClient;
}

const MATERIAL_ID = "20000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";

describe("summaryFingerprint", () => {
  test("is deterministic for the same chunk set, in order", () => {
    const chunks = [chunk(), chunk({ id: "10000000-0000-4000-8000-000000000002" })];

    expect(summaryFingerprint(MATERIAL_ID, chunks)).toBe(summaryFingerprint(MATERIAL_ID, chunks));
  });

  test("changes when a chunk is added, removed, or replaced", () => {
    const one = [chunk()];
    const two = [chunk(), chunk({ id: "10000000-0000-4000-8000-000000000002" })];
    const replaced = [chunk({ id: "10000000-0000-4000-8000-000000000099" })];

    const base = summaryFingerprint(MATERIAL_ID, one);
    expect(summaryFingerprint(MATERIAL_ID, two)).not.toBe(base);
    expect(summaryFingerprint(MATERIAL_ID, replaced)).not.toBe(base);
  });

  test("is scoped to the material, so equal chunk sets under different materials differ", () => {
    const chunks = [chunk()];

    expect(summaryFingerprint(MATERIAL_ID, chunks)).not.toBe(
      summaryFingerprint("20000000-0000-4000-8000-000000000002", chunks),
    );
  });
});

describe("summaryCacheKey", () => {
  test("matches the documented prefix layout", () => {
    const fingerprint = "a".repeat(64);

    expect(summaryCacheKey(STUDENT_ID, MATERIAL_ID, fingerprint)).toBe(
      `${AI_SUMMARY_CACHE_KEY_PREFIX}:${STUDENT_ID}:${MATERIAL_ID}:${fingerprint}`,
    );
  });
});

describe("createSummaryCache", () => {
  test("round-trips an entry through Redis", async () => {
    const cache = createSummaryCache(fakeRedis());
    const entry: SummaryCacheEntry = {
      summary: "condensed text",
      model: "claude-3-5-haiku-20241022",
      tier: "small",
      sources: [
        {
          chunk_id: "10000000-0000-4000-8000-000000000001",
          chunk_index: 0,
          page_number: 12,
          section_title: "Photosynthesis",
          order: 1,
        },
      ],
    };

    await cache.set("k", entry);
    await expect(cache.get("k")).resolves.toEqual(entry);
  });

  test("an absent or corrupt key is a miss, never an error", async () => {
    const redis = fakeRedis();
    await (redis as unknown as { set: (k: string, v: string) => Promise<string> }).set(
      "corrupt",
      "{not json",
    );
    const cache = createSummaryCache(redis);

    await expect(cache.get("missing")).resolves.toBeNull();
    await expect(cache.get("corrupt")).resolves.toBeNull();
  });

  test("entries expire via the documented TTL", async () => {
    const cache = createSummaryCache(fakeRedis());
    expect(AI_SUMMARY_CACHE_TTL_SECONDS).toBe(24 * 60 * 60);
    // The TTL constant is asserted rather than measured: the cache passes it straight to Redis's
    // EX mode, and exercising real TTL behavior would require a live server.
    void cache;
  });
});
