import { AI_CONCEPTS_CACHE_KEY_PREFIX, AI_SUMMARY_CACHE_KEY_PREFIX } from "./config";

import type { RedisClient } from "../../redis";

/** The Redis caches whose keys carry a material id as their third segment. */
const MATERIAL_CACHE_PREFIXES = [AI_SUMMARY_CACHE_KEY_PREFIX, AI_CONCEPTS_CACHE_KEY_PREFIX];

/**
 * Delete the cached AI summaries and key concepts generated from any of `materialIds`.
 *
 * Both caches key on `<prefix>:<studentId>:<materialId>:...`, so a material's entries cannot be
 * addressed without the student; this walks each prefix with SCAN (never KEYS, which blocks Redis)
 * and unlinks the matching keys. The caches are already unreachable once a class's AI materials
 * setting is off -- every read path refuses the material before the cache is consulted, and the
 * fingerprint changes on re-ingestion -- and they expire within a day, so this is best-effort
 * hygiene: callers swallow its errors rather than fail a committed change.
 *
 * Returns the number of keys removed.
 */
export async function purgeMaterialAiCaches(
  redis: RedisClient,
  materialIds: readonly string[],
): Promise<number> {
  if (materialIds.length === 0) return 0;
  const wanted = new Set(materialIds);
  let removed = 0;

  for (const prefix of MATERIAL_CACHE_PREFIXES) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 1000);
      cursor = next;
      const doomed = keys.filter((key) => {
        const materialId = key.split(":")[2];
        return materialId !== undefined && wanted.has(materialId);
      });
      if (doomed.length > 0) {
        removed += await redis.unlink(...doomed);
      }
    } while (cursor !== "0");
  }

  return removed;
}
