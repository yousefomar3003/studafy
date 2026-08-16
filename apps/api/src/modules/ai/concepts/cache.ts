import { AI_CONCEPTS_CACHE_KEY_PREFIX, AI_CONCEPTS_CACHE_TTL_SECONDS } from "../config";
import { summaryFingerprint } from "../summary/cache";

import type { RedisClient } from "../../../redis";
import type { AiModelTier } from "../llm/routing";

/**
 * Redis-backed concept cache (ST-169).
 *
 * A material's concept list is deterministic once the material's chunks exist (the prompt is pure),
 * so the route can serve a repeat request from cache instead of spending quota on a second
 * generation. The cache is an accelerator, never a dependency: a miss, an eviction, or a transient
 * Redis error all degrade to regenerating.
 *
 * The cache key is `aiconc:{studentId}:{materialId}:{fingerprint}`, the family convention the `aiq`
 * meter counters and the `aisum` summary cache use. The fingerprint is the summarizer's chunk-set
 * digest (`summaryFingerprint`), shared rather than duplicated because "which chunks does this
 * material currently have" is the same material-version fact both caches key on. Entries expire
 * after `AI_CONCEPTS_CACHE_TTL_SECONDS`.
 */

export interface ConceptCacheSource {
  chunk_id: string;
  chunk_index: number;
  page_number: number | null;
  section_title: string | null;
  order: number;
}

export interface ConceptCacheItem {
  name: string;
  explanation: string;
  /** The anchors this concept is grounded on, rendered from its merged source_ids. */
  sources: ConceptCacheSource[];
}

export interface ConceptCacheEntry {
  concepts: ConceptCacheItem[];
  model: string;
  tier: AiModelTier;
}

export interface ConceptsCache {
  get(key: string): Promise<ConceptCacheEntry | null>;
  set(key: string, entry: ConceptCacheEntry): Promise<void>;
}

export function conceptsCacheKey(
  studentId: string,
  materialId: string,
  fingerprint: string,
): string {
  return `${AI_CONCEPTS_CACHE_KEY_PREFIX}:${studentId}:${materialId}:${fingerprint}`;
}

export { summaryFingerprint as conceptsFingerprint };

export function createConceptsCache(redis: RedisClient): ConceptsCache {
  return {
    async get(key) {
      const raw = await redis.get(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as ConceptCacheEntry;
      } catch {
        // Corrupt or unexpected payloads are treated as a miss; the entry is overwritten on the
        // next successful generation rather than surfacing to the caller.
        return null;
      }
    },
    async set(key, entry) {
      await redis.set(key, JSON.stringify(entry), "EX", AI_CONCEPTS_CACHE_TTL_SECONDS);
    },
  };
}
