// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { createRedisClient } from "../../../redis";

import { aiQuotaKey, aiQuotaPeriodKey, createAiTokenMeter } from "./meter";

import type { RedisClient } from "../../../redis";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLogger = {
  level: "info" as const,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

async function createTestClient(): Promise<RedisClient | null> {
  try {
    const client = createRedisClient({ url: "redis://localhost:6390/0", logger: silentLogger });
    await client.connect();
    await client.ping();
    return client;
  } catch {
    return null;
  }
}

async function clearAiQuotaKeys(client: RedisClient): Promise<void> {
  let cursor = "0";
  do {
    const [nextCursor, keys] = (await client.scan(cursor, "MATCH", "aiq:*", "COUNT", "100")) as [
      string,
      string[],
    ];
    cursor = nextCursor;
    if (keys.length > 0) {
      await client.del(...keys);
    }
  } while (cursor !== "0");
}

let cleanupClient: RedisClient | null = null;

beforeEach(async () => {
  if (!cleanupClient) {
    cleanupClient = await createTestClient();
  }
  if (cleanupClient) {
    await clearAiQuotaKeys(cleanupClient);
  }
});

afterAll(async () => {
  await cleanupClient?.quit();
});

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const PERIOD_START = "2026-08-01T00:00:00.000Z";
const PERIOD_END = "2026-08-31T23:59:59.000Z";
const PERIOD_START_NEXT = "2026-09-01T00:00:00.000Z";
const PERIOD_END_NEXT = "2026-09-30T23:59:59.000Z";

// ---------------------------------------------------------------------------
// Functional tests — require Redis
// ---------------------------------------------------------------------------

describe("createAiTokenMeter (requires Redis)", () => {
  test("reserves tokens and reports the remaining budget", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const meter = createAiTokenMeter({ redis: client });
      const reservation = await meter.reserve({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
        amount: 10,
      });

      expect(reservation.ok).toBe(true);
      if (reservation.ok) {
        expect(reservation.remaining).toBe(90);
      }

      const snapshot = await meter.snapshot({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
      });
      expect(snapshot).toMatchObject({
        active: true,
        budget: 100,
        usedTokens: 0,
        heldTokens: 10,
        remaining: 90,
      });
    } finally {
      await client.quit();
    }
  });

  test("commit moves the hold into used tokens", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const meter = createAiTokenMeter({ redis: client });
      const reservation = await meter.reserve({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
        amount: 10,
      });
      expect(reservation.ok).toBe(true);
      if (!reservation.ok) return;

      const committed = await meter.commit({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        reservationId: reservation.reservationId,
        consumedTokens: 6,
      });
      expect(committed).toEqual({ settled: true, remaining: 94 });

      const snapshot = await meter.snapshot({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
      });
      expect(snapshot).toMatchObject({ usedTokens: 6, heldTokens: 0, remaining: 94 });
    } finally {
      await client.quit();
    }
  });

  test("release returns the hold without counting usage", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const meter = createAiTokenMeter({ redis: client });
      const reservation = await meter.reserve({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
        amount: 10,
      });
      expect(reservation.ok).toBe(true);
      if (!reservation.ok) return;

      const released = await meter.release({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        reservationId: reservation.reservationId,
      });
      expect(released).toEqual({ settled: true, remaining: 100 });

      const snapshot = await meter.snapshot({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
      });
      expect(snapshot).toMatchObject({ usedTokens: 0, heldTokens: 0, remaining: 100 });
    } finally {
      await client.quit();
    }
  });

  test("refuses when the budget is exhausted", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const meter = createAiTokenMeter({ redis: client });
      const first = await meter.reserve({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
        amount: 100,
      });
      expect(first.ok).toBe(true);

      const refused = await meter.reserve({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
        amount: 10,
      });
      expect(refused).toMatchObject({ ok: false, reason: "exhausted", currentUsage: 100 });
    } finally {
      await client.quit();
    }
  });

  test("refuses with insufficient when what remains cannot cover the reservation", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const meter = createAiTokenMeter({ redis: client });
      const first = await meter.reserve({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
        amount: 90,
      });
      expect(first.ok).toBe(true);

      const refused = await meter.reserve({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
        amount: 20,
      });
      expect(refused).toMatchObject({ ok: false, reason: "insufficient", currentUsage: 90 });
      if (!refused.ok) {
        expect(refused.retryAfterSeconds).toBeGreaterThan(0);
      }
    } finally {
      await client.quit();
    }
  });

  test("commit and release are idempotent", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const meter = createAiTokenMeter({ redis: client });
      const reservation = await meter.reserve({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
        amount: 10,
      });
      expect(reservation.ok).toBe(true);
      if (!reservation.ok) return;

      const base = {
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        reservationId: reservation.reservationId,
      };

      const first = await meter.commit({ ...base, consumedTokens: 4 });
      expect(first.settled).toBe(true);
      const second = await meter.commit({ ...base, consumedTokens: 4 });
      expect(second.settled).toBe(false);

      const released = await meter.release(base);
      expect(released.settled).toBe(false);
    } finally {
      await client.quit();
    }
  });

  test("commit beyond the reservation throws", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const meter = createAiTokenMeter({ redis: client });
      const reservation = await meter.reserve({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
        amount: 10,
      });
      expect(reservation.ok).toBe(true);
      if (!reservation.ok) return;

      await expect(
        meter.commit({
          schoolId: SCHOOL_ID,
          studentId: STUDENT_ID,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          reservationId: reservation.reservationId,
          consumedTokens: 11,
        }),
      ).rejects.toThrow(/exceeds reservation/);
    } finally {
      await client.quit();
    }
  });

  test("billing periods are independent: the budget resets on renewal", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const meter = createAiTokenMeter({ redis: client });
      const reservation = await meter.reserve({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
        amount: 100,
      });
      expect(reservation.ok).toBe(true);

      const nextPeriod = await meter.snapshot({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START_NEXT,
        periodEnd: PERIOD_END_NEXT,
        budget: 100,
      });
      expect(nextPeriod).toMatchObject({ active: false, usedTokens: 0, remaining: 100 });
    } finally {
      await client.quit();
    }
  });

  test("snapshot on a fresh period reports inactive", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const meter = createAiTokenMeter({ redis: client });
      const snapshot = await meter.snapshot({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
      });
      expect(snapshot.active).toBe(false);
      expect(snapshot.remaining).toBe(100);
    } finally {
      await client.quit();
    }
  });

  test("reserve sets a bounded TTL on the counter key", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const meter = createAiTokenMeter({ redis: client });
      await meter.reserve({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 100,
        amount: 10,
      });

      const key = aiQuotaKey(SCHOOL_ID, STUDENT_ID, aiQuotaPeriodKey(PERIOD_START));
      const ttl = await client.ttl(key);
      expect(ttl).toBeGreaterThan(0);
    } finally {
      await client.quit();
    }
  });

  test("concurrent reserves never over-commit the budget", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const meter = createAiTokenMeter({ redis: client });

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          meter.reserve({
            schoolId: SCHOOL_ID,
            studentId: STUDENT_ID,
            periodStart: PERIOD_START,
            periodEnd: PERIOD_END,
            budget: 10,
            amount: 3,
          }),
        ),
      );

      const accepted = results.filter((r) => r.ok);
      const refused = results.filter((r) => !r.ok);
      const reserved = accepted.reduce((sum, r) => sum + (r.ok ? r.reservedTokens : 0), 0);

      // floor(10 / 3) reservations can be placed; the rest must be refused.
      expect(accepted.length).toBe(3);
      expect(refused.length).toBe(7);
      expect(reserved).toBeLessThanOrEqual(10);
      expect(reserved).toBe(9);

      const snapshot = await meter.snapshot({
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 10,
      });
      expect(snapshot.heldTokens).toBe(9);
      expect(snapshot.remaining).toBe(1);
      expect(snapshot.usedTokens).toBe(0);
    } finally {
      await client.quit();
    }
  });
});
