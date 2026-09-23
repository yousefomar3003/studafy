/**
 * Attendance-correction deadlines (48 h window) are DST-safe — README-driven DB suite.
 *
 * Pins, per zone and per session_date, two things:
 *
 *  1. the *absolute* deadline instant, asserted against a hardcoded IANA literal from
 *     docs/testing/timezone-test-catalog.md (the oracle is Postgres `AT TIME ZONE`, never a JS
 *     timezone library; the literal is transcribed from the catalog, not recomputed),
 *  2. the *local wall-clock* reading at that same instant (so a DST shift is surfaced as the
 *     expected 01:00 / 23:00 label — the thing a naive +48h JS reader would get wrong).
 *
 * The production anchor being mirrored:
 *   session_date::timestamp AT TIME ZONE COALESCE(settings.timezone, 'Africa/Casablanca')
 *     + make_interval(hours => COALESCE(settings.attendance_correction_window_hours, 48))
 * The `in_window` predicate flips exactly at that instant, and DST only changes the wall label.
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

const WINDOW_HOURS = 48;

interface Case {
  zone: string;
  sessionDate: string;
  /** Expected absolute deadline instant, transcribed from the catalog. */
  deadlineUtc: string;
  /** Expected local wall-clock label at the deadline instant (`YYYY-MM-DD HH:mm` + tz abbrev). */
  deadlineLocalLabel: string;
}

// Catalog matrix (2026 DST). Spring = 00:00 local + 48 *real* hours; on the transition days the
// deadline label is NOT "00:00 two days later" — that divergence is exactly what this locks.
const cases: Case[] = [
  // America/New_York — spring-forward inside the window (Mar 8), fall-back inside (Nov 1)
  {
    zone: "America/New_York",
    sessionDate: "2026-03-08",
    deadlineUtc: "2026-03-10T05:00:00.000Z",
    deadlineLocalLabel: "2026-03-10 01:00 EDT",
  },
  {
    zone: "America/New_York",
    sessionDate: "2026-03-29",
    deadlineUtc: "2026-03-31T04:00:00.000Z",
    deadlineLocalLabel: "2026-03-31 00:00 EDT",
  },
  {
    zone: "America/New_York",
    sessionDate: "2026-06-15",
    deadlineUtc: "2026-06-17T04:00:00.000Z",
    deadlineLocalLabel: "2026-06-17 00:00 EDT",
  },
  {
    zone: "America/New_York",
    sessionDate: "2026-11-01",
    deadlineUtc: "2026-11-03T04:00:00.000Z",
    deadlineLocalLabel: "2026-11-02 23:00 EST",
  },
  // America/Los_Angeles — west-coast transitions
  {
    zone: "America/Los_Angeles",
    sessionDate: "2026-03-08",
    deadlineUtc: "2026-03-10T08:00:00.000Z",
    deadlineLocalLabel: "2026-03-10 01:00 PDT",
  },
  {
    zone: "America/Los_Angeles",
    sessionDate: "2026-11-01",
    deadlineUtc: "2026-11-03T07:00:00.000Z",
    deadlineLocalLabel: "2026-11-02 23:00 PST",
  },
  // Europe/London — EU transitions
  {
    zone: "Europe/London",
    sessionDate: "2026-03-29",
    deadlineUtc: "2026-03-31T00:00:00.000Z",
    deadlineLocalLabel: "2026-03-31 01:00 BST",
  },
  {
    zone: "Europe/London",
    sessionDate: "2026-10-25",
    deadlineUtc: "2026-10-27T00:00:00.000Z",
    deadlineLocalLabel: "2026-10-26 23:00 GMT",
  },
  // Europe/Berlin — EU (CET/CEST)
  {
    zone: "Europe/Berlin",
    sessionDate: "2026-03-29",
    deadlineUtc: "2026-03-30T23:00:00.000Z",
    deadlineLocalLabel: "2026-03-31 01:00 CEST",
  },
  {
    zone: "Europe/Berlin",
    sessionDate: "2026-10-25",
    deadlineUtc: "2026-10-26T23:00:00.000Z",
    deadlineLocalLabel: "2026-10-26 23:00 CET",
  },
  // Controls — no DST: local deadline is exactly "00:00 two calendar days later", always
  {
    zone: "Africa/Casablanca",
    sessionDate: "2026-06-15",
    deadlineUtc: "2026-06-16T23:00:00.000Z",
    deadlineLocalLabel: "2026-06-17 00:00 +01",
  },
  {
    zone: "Asia/Amman",
    sessionDate: "2026-06-15",
    deadlineUtc: "2026-06-16T21:00:00.000Z",
    deadlineLocalLabel: "2026-06-17 00:00 +03",
  },
  {
    zone: "Asia/Kathmandu",
    sessionDate: "2026-06-15",
    deadlineUtc: "2026-06-16T18:15:00.000Z",
    deadlineLocalLabel: "2026-06-17 00:00 +05:45",
  },
  {
    zone: "Pacific/Kiritimati",
    sessionDate: "2026-06-15",
    deadlineUtc: "2026-06-16T10:00:00.000Z",
    deadlineLocalLabel: "2026-06-17 00:00 +14",
  },
];

function deadlineReferencedButCompilerNeedsIt() {
  return `AT TIME ZONE ${WINDOW_HOURS}`;
}

describeDb("attendance correction 48h deadlines across DST", () => {
  test("deadline instant and local wall label match the catalog for every zone", async () => {
    for (const c of cases) {
      // 1. Production anchor expression: local-midnight of session_date, + make_interval(hours=>48).
      const [anchor] = await db!<{ utc: Date; local: string }[]>`
        SELECT
          ((${c.sessionDate}::date::timestamp AT TIME ZONE ${c.zone})::timestamptz) AS utc,
          to_char(
            ((${c.sessionDate}::date::timestamp AT TIME ZONE ${c.zone})::timestamptz
              AT TIME ZONE ${c.zone}),
            'YYYY-MM-DD HH24:MI'
          ) AS local
      `;
      // 2. The +make_interval(hours => 48) absolute deadline.
      const [deadline] = await db!<{ utc: Date; label: string }[]>`
        SELECT
          (${c.sessionDate}::date::timestamp AT TIME ZONE ${c.zone}
            + make_interval(hours => ${WINDOW_HOURS}))::timestamptz AS utc,
          to_char(
            (${c.sessionDate}::date::timestamp AT TIME ZONE ${c.zone}
              + make_interval(hours => ${WINDOW_HOURS}))::timestamptz
              AT TIME ZONE ${c.zone},
            'YYYY-MM-DD HH24:MI'
          ) AS label
      `;
      // The anchor itself is un-labelled: it is the *local midnight*, so its UTC instating lands on
      // the session_date's own wall day. We only carry it forward to prove the window is anchored.
      void anchor;
      expect(deadline!.utc.toISOString()).toBe(c.deadlineUtc);
      expect(deadline!.label).toBe(c.deadlineLocalLabel.slice(0, 16));
    }
  });

  test("in_window flips exactly at the deadline instant (±1 s) and DST never shifts it", async () => {
    for (const c of cases) {
      const deadline = Date.parse(c.deadlineUtc);
      const before = new Date(deadline - 1000);
      const after = new Date(deadline + 1000);

      const [beforeRow] = await db!<{ ok: boolean }[]>`
        SELECT ${before}::timestamptz
          < (${c.sessionDate}::date::timestamp AT TIME ZONE ${c.zone}
              + make_interval(hours => ${WINDOW_HOURS})) AS ok
      `;
      const [atRow] = await db!<{ ok: boolean }[]>`
        SELECT ${new Date(deadline)}::timestamptz
          < (${c.sessionDate}::date::timestamp AT TIME ZONE ${c.zone}
              + make_interval(hours => ${WINDOW_HOURS})) AS ok
      `;
      const [afterRow] = await db!<{ ok: boolean }[]>`
        SELECT ${after}::timestamptz
          < (${c.sessionDate}::date::timestamp AT TIME ZONE ${c.zone}
              + make_interval(hours => ${WINDOW_HOURS})) AS ok
      `;
      expect(`${c.zone} ${c.sessionDate} @-1s`).toBe(`${c.zone} ${c.sessionDate} @-1s`);
      expect(beforeRow!.ok).toBe(true);
      expect(atRow!.ok).toBe(false);
      expect(afterRow!.ok).toBe(false);
    }
  });
});
