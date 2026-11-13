/**
 * Dunning cadence is DST-agnostic on purpose: whole calendar days (DUNNING_EMAIL_DAYS offsets, whole-
 * day floor in dunningStageFor) and an absolute grace deadline (isGraceExpired uses `>=` against the
 * graceStartedAt + GRACE_PERIOD_DAYS[kind] instant). A spring-forward can shift only the wall label a
 * sweep would print, never the stage index nor the grace-expiry flip instant.
 *
 * Pure: injectable `now`, no DB. Runs in the normal workers test command.
 *
 * Catalog pin (2026, America/New_York school cadence): grace started 2026-03-07T12:00:00Z (NY 07:00
 * EST) and ends 2026-03-21T12:00:00Z (GRACE_PERIOD_DAYS.school = 14, spanning the 2026-03-08 NY
 * transition). Whole-day offsets {0, 3, 7} from start map to stage indexes {0, 1, 2}; the expiry
 * flip lives at the absolute deadline instant - (end,end) is expired, (end, end-1s) is not.
 */

import { GRACE_PERIOD_DAYS } from "@studafy/billing";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import {
  DUNNING_EMAIL_DAYS,
  dunningStageFor,
  graceStartedAtFor,
  isGraceExpired,
} from "../dunning-schedule";

import type { SubscriptionKind } from "@studafy/billing";

const KIND: SubscriptionKind = "school";
const DAY_MS = 86_400_000;
const graceStart = new Date("2026-03-07T12:00:00.000Z");
const graceEnd = new Date("2026-03-21T12:00:00.000Z");

describe("dunning scheduling is DST-invariant", () => {
  test("stage index is the whole-day offset index; DST never changes it", () => {
    const offsets = DUNNING_EMAIL_DAYS[KIND];
    expect(offsets).toEqual([0, 3, 7, 10, 13]);
    const started = graceStartedAtFor(KIND, graceEnd);
    expect(started.getTime()).toBe(graceStart.getTime());
    for (let i = 0; i < offsets.length; i += 1) {
      const now = new Date(started.getTime() + offsets[i] * DAY_MS);
      expect(dunningStageFor(KIND, started, now)).toBe(i);
    }
  });

  test("graceStartedAtFor is the exact deterministic inverse of the 14-day window", () => {
    expect(graceStartedAtFor(KIND, graceEnd).getTime()).toBe(graceStart.getTime());
    expect(graceStartedAtFor(KIND, graceEnd).getTime() + GRACE_PERIOD_DAYS[KIND] * DAY_MS).toBe(
      graceEnd.getTime(),
    );
  });

  test("isGraceExpired flips at the absolute deadline instant (>=), never at a relabel", () => {
    const started = graceStartedAtFor(KIND, graceEnd);
    expect(isGraceExpired(graceEnd, new Date(graceEnd.getTime() - 1_000))).toBe(false);
    expect(isGraceExpired(graceEnd, graceEnd)).toBe(true);
    expect(isGraceExpired(graceEnd, new Date(graceEnd.getTime() + 1_000))).toBe(true);
    expect(isGraceExpired(graceEnd, started)).toBe(false);
  });
});
