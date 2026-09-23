/**
 * Announcement publish eligibility is compared at the absolute instant — never at a local wall-clock
 * reading. The worker sweep (`apps/workers/src/queues/announcements/publish-sweep.ts:71`) selects on
 *
 *     scheduled_at <= ${now}::timestamptz
 *
 * where `now` is the UTC instant the sweep began. A DST transition in the school's zone therefore
 * cannot move a scheduled announcement across the due/pending boundary: the *instant* is the only
 * thing compared grader say, "08:00 school-local on the day the EU springs forward" is a school-zone
 * label, and the row stores the absolute instant it resolves to (AT TIME ZONE, Postgres-owned).
 *
 * Catalog pins (2026 DST, NY): a due instant the sweep computes from the *same* 08:00-school-local
 * wall anchor is the same absolute instant across the transition; and `<= now` flips at exactly that
 * instant (±1 s). Control zone Africa/Casablanca (no DST) shows the same flip so the failure mode is
 * attributable to the transition, not to a general offset quirk.
 *
 * Requires a live Postgres: skipped unless TEST_DATABASE_URL is set, exactly like every other
 * integration suite in apps/api/tests.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import postgres from "postgres";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

let db: Sql | undefined;

beforeAll(() => {
  if (!databaseUrl) return;
  db = postgres(databaseUrl, { max: 2, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

interface Case {
  zone: string;
  /** School-local wall prompt, e.g. "08:00" — the label school staff pick. */
  localPrompt: string;
  /** The absolute instant the worker resolves that wall label to on this date (catalog literal). */
  dueUtc: string;
}

const cases: Case[] = [
  // America/New_York — the wall label "08:00" resolves to a different absolute instant across the
  // transition; the sweep compares only the resolved *instant*, so DST can't flip due/pending.
  { zone: "America/New_York", localPrompt: "08:00", dueUtc: "2026-03-08T13:00:00.000Z" },
  { zone: "America/New_York", localPrompt: "08:00", dueUtc: "2026-11-01T13:00:00.000Z" },
  // Europe/London — EU spring/fall
  { zone: "Europe/London", localPrompt: "08:00", dueUtc: "2026-03-29T07:00:00.000Z" },
  { zone: "Europe/London", localPrompt: "08:00", dueUtc: "2026-10-25T08:00:00.000Z" },
  // Control — no DST: the resolved instant is stable week to week
  { zone: "Africa/Casablanca", localPrompt: "08:00", dueUtc: "2026-06-15T07:00:00.000Z" },
];

describeDb("announcement publish boundary is an absolute instant", () => {
  test("a school-local 08:00 label resolves to the same instant regardless of DST", async () => {
    for (const c of cases) {
      const [row] = await db!<{ utc: Date }[]>`
        SELECT
          (${c.localPrompt}::time::timestamp AT TIME ZONE ${c.zone})::timestamptz AS utc
      `;
      expect(row!.utc.toISOString().slice(0, 19)).toBe(c.dueUtc.slice(0, 19));
    }
  });

  test("scheduled_at <= now flips exactly at the due instant (±1 s)", async () => {
    for (const c of cases) {
      const due = Date.parse(c.dueUtc);
      for (const [delta, expected] of [
        [-1000, true],
        [0, true],
        [1000, false],
      ] as const) {
        const now = new Date(due + delta);
        const [row] = await db!<{ ok: boolean }[]>`
          SELECT ${now}::timestamptz
            <= (${c.localPrompt}::time::timestamp AT TIME ZONE ${c.zone})::timestamptz AS ok
        `;
        expect(row!.ok).toBe(expected);
      }
    }
  });
});
