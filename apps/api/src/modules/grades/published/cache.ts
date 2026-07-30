import { cacheKey, getCache, singleFlight } from "../../../cache";

import { publishedGradeSnapshotSchema } from "./schemas";

import type { PublishedGradeSnapshot } from "./schemas";
import type { Logger } from "../../../logger";
import type { RedisClient } from "../../../redis";

export const PUBLISHED_GRADES_CACHE_TTL_SECONDS = 3_600;
const REVISION_TTL_SECONDS = PUBLISHED_GRADES_CACHE_TTL_SECONDS * 2;

const REVISION_CHECKED_SET = `
local current = redis.call("GET", KEYS[2])
if not current then current = "0" end
if current ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
redis.call("SADD", KEYS[3], KEYS[1])
redis.call("EXPIRE", KEYS[3], ARGV[3])
return 1
`;

const INVALIDATE_STUDENT = `
local members = redis.call("SMEMBERS", KEYS[1])
redis.call("INCR", KEYS[2])
redis.call("EXPIRE", KEYS[2], ARGV[1])
for _, member in ipairs(members) do
  redis.call("DEL", member)
end
redis.call("DEL", KEYS[1])
return #members
`;

export function publishedGradeCacheKey(
  schoolId: string,
  studentId: string,
  termId: string,
): ReturnType<typeof cacheKey> {
  return cacheKey(schoolId, "grades", "published", studentId, termId);
}

function publishedGradeIndexKey(schoolId: string, studentId: string): ReturnType<typeof cacheKey> {
  return cacheKey(schoolId, "grades", "published", studentId, "terms");
}

function publishedGradeRevisionKey(
  schoolId: string,
  studentId: string,
): ReturnType<typeof cacheKey> {
  return cacheKey(schoolId, "grades", "published", studentId, "revision");
}

export async function getPublishedGradeCache(
  redis: RedisClient,
  schoolId: string,
  studentId: string,
  termId: string,
): Promise<PublishedGradeSnapshot | null> {
  const cached = await getCache<PublishedGradeSnapshot>(
    redis,
    publishedGradeCacheKey(schoolId, studentId, termId),
  );
  return cached ? publishedGradeSnapshotSchema.parse(cached) : null;
}

export async function getPublishedGradeRevision(
  redis: RedisClient,
  schoolId: string,
  studentId: string,
): Promise<string> {
  return (await redis.get(publishedGradeRevisionKey(schoolId, studentId))) ?? "0";
}

export async function setPublishedGradeCacheIfCurrent(
  redis: RedisClient,
  schoolId: string,
  studentId: string,
  termId: string,
  expectedRevision: string,
  value: PublishedGradeSnapshot,
): Promise<boolean> {
  const result = await redis.eval(
    REVISION_CHECKED_SET,
    3,
    publishedGradeCacheKey(schoolId, studentId, termId),
    publishedGradeRevisionKey(schoolId, studentId),
    publishedGradeIndexKey(schoolId, studentId),
    expectedRevision,
    JSON.stringify(value),
    String(PUBLISHED_GRADES_CACHE_TTL_SECONDS),
  );
  return Number(result) === 1;
}

export async function invalidatePublishedGradeCache(
  redis: RedisClient,
  schoolId: string,
  studentId: string,
): Promise<number> {
  const result = await redis.eval(
    INVALIDATE_STUDENT,
    2,
    publishedGradeIndexKey(schoolId, studentId),
    publishedGradeRevisionKey(schoolId, studentId),
    String(REVISION_TTL_SECONDS),
  );
  return Number(result);
}

export async function loadPublishedGradeSnapshotCached(options: {
  redis: RedisClient;
  logger: Logger;
  schoolId: string;
  studentId: string;
  termId: string;
  load: () => Promise<PublishedGradeSnapshot>;
}): Promise<PublishedGradeSnapshot> {
  const { redis, logger, schoolId, studentId, termId, load } = options;
  const key = publishedGradeCacheKey(schoolId, studentId, termId);

  try {
    const cached = await getPublishedGradeCache(redis, schoolId, studentId, termId);
    if (cached) return cached;
  } catch (err) {
    logger.warn(
      { err, school_id: schoolId, student_id: studentId, term_id: termId },
      "published grades cache read failed; querying database",
    );
  }

  return singleFlight(key, async () => {
    let revision = "0";
    try {
      const cached = await getPublishedGradeCache(redis, schoolId, studentId, termId);
      if (cached) return cached;
      revision = await getPublishedGradeRevision(redis, schoolId, studentId);
    } catch (err) {
      logger.warn(
        { err, school_id: schoolId, student_id: studentId, term_id: termId },
        "published grades cache recheck failed; querying database",
      );
    }

    const snapshot = await load();

    try {
      await setPublishedGradeCacheIfCurrent(redis, schoolId, studentId, termId, revision, snapshot);
    } catch (err) {
      logger.warn(
        { err, school_id: schoolId, student_id: studentId, term_id: termId },
        "published grades cache write failed",
      );
    }

    return snapshot;
  });
}
