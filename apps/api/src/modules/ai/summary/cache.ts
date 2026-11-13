import { createHash } from "node:crypto";

import {
  AI_SUMMARY_CACHE_KEY_PREFIX,
  AI_SUMMARY_CACHE_TTL_SECONDS,
  type AiSummaryLength,
} from "../config";

import type { LoadedSummaryChunk } from "./materials";
import type { RedisClient } from "../../../redis";
import type { AiModelTier } from "../llm/routing";

/**
 * Redis-backed summary cache.
 *
 * A summary of a given material for a given student is deterministic once the material's chunks
 * exist (the prompt is pure), so the route can serve a repeat request from cache instead of
 * spending quota on a second generation. The cache is an accelerator, never a dependency: a
 * miss, an eviction, or a transient Redis error all degrade to regenerating.
 *
 * Cache keys live under the `aisum` prefix
 * (`aisum:{studentId}:{materialId}:{length}:{fingerprint}`), the family convention the `aiq` meter
 * counters use. The `length` segment keeps each summary-length preset a separate entry, so a
 * client switching presets hits the cache once each preset has been generated once. Entries expire
 * after `AI_SUMMARY_CACHE_TTL_SECONDS`.
 */

export interface SummaryCacheSource {
  chunk_id: string;
  chunk_index: number;
  page_number: number | null;
  section_title: string | null;
  order: number;
}

export interface SummaryCacheEntry {
  summary: string;
  model: string;
  tier: AiModelTier;
  /** The length preset this entry was generated for; echoed back on a cache hit. */
  length: AiSummaryLength;
  /** The sources the summary was grounded on, enough to reproduce the response without the model. */
  sources: SummaryCacheSource[];
}

export interface SummaryCache {
  get(key: string): Promise<SummaryCacheEntry | null>;
  set(key: string, entry: SummaryCacheEntry): Promise<void>;
}

/**
 * A stable digest of "which chunks this material currently has". Keyed on the chunk rows in order
 * rather than their text: re-ingestion produces new chunk ids (new fingerprint, fresh summary),
 * while a cosmetic title edit that leaves the chunks untouched still hits the cache.
 */
export function summaryFingerprint(
  materialId: string,
  chunks: readonly LoadedSummaryChunk[],
): string {
  const hash = createHash("sha256");
  hash.update(materialId);
  for (const chunk of chunks) {
    hash.update("\n");
    hash.update(chunk.id);
  }
  return hash.digest("hex");
}

export function summaryCacheKey(
  studentId: string,
  materialId: string,
  length: AiSummaryLength,
  fingerprint: string,
): string {
  return `${AI_SUMMARY_CACHE_KEY_PREFIX}:${studentId}:${materialId}:${length}:${fingerprint}`;
}

export function createSummaryCache(redis: RedisClient): SummaryCache {
  return {
    async get(key) {
      const raw = await redis.get(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as SummaryCacheEntry;
      } catch {
        // Corrupt or unexpected payloads are treated as a miss; the entry is overwritten on the
        // next successful generation rather than surfacing to the caller.
        return null;
      }
    },
    async set(key, entry) {
      await redis.set(key, JSON.stringify(entry), "EX", AI_SUMMARY_CACHE_TTL_SECONDS);
    },
  };
}
