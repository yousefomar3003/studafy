/**
 * The dunning schedule (ST-134): when each reminder of the sequence falls, and when the window is over.
 *
 * Pure and clock-injectable. Everything here is a function of `(now, grace_start)`, so the sweep can
 * be exercised against a simulated clock without a database and without sleeping. The only wall-clock
 * input is a `Date` the caller passes in; the sweep's caller owns the real `new Date()`.
 */

import { GRACE_PERIOD_DAYS } from "@studafy/billing";

import type { SubscriptionKind } from "@studafy/billing";

export const MILLIS_PER_DAY = 86_400_000;

/**
 * The reminder days, counted from the moment the subscription entered `grace_period`.
 *
 * The school window is 14 days, so the sequence is a day-0 notice then reminders ahead of the
 * day-14 lockout. The AI window is 7 days, so its sequence is shorter. Each entry is the day on
 * which that stage's reminder becomes due; the final entry is always the day before the lockout.
 */
export const DUNNING_EMAIL_DAYS: Readonly<Record<SubscriptionKind, readonly number[]>> = {
  school: [0, 3, 7, 10, 13],
  ai: [0, 3, 6],
};

/**
 * The stage of the sequence a subscription is currently due, or -1 before the first reminder.
 *
 * Returns the index of the last day-offset that has passed. If several stages came due between two
 * sweeps, this returns only the most advanced one: the sweep sends exactly that reminder and stores
 * the stage, so a late run skips the back-dated ones rather than spam-sending a week of reminders
 * at once.
 */
export function dunningStageFor(kind: SubscriptionKind, graceStartedAt: Date, now: Date): number {
  const elapsedDays = (now.getTime() - graceStartedAt.getTime()) / MILLIS_PER_DAY;
  const offsets = DUNNING_EMAIL_DAYS[kind];

  let stage = -1;
  for (let index = 0; index < offsets.length; index += 1) {
    if (elapsedDays >= offsets[index]) stage = index;
  }
  return stage;
}

/**
 * Reconstruct the moment a grace window started from its deadline.
 *
 * The state machine stamps `grace_period_ends_at` as `entry + GRACE_PERIOD_DAYS[kind]`, so this is
 * the exact inverse. The sweep needs the start to know where the reminder sequence is, and it has
 * only the deadline on the row -- the start is never stored separately.
 */
export function graceStartedAtFor(kind: SubscriptionKind, gracePeriodEndsAt: Date): Date {
  return new Date(gracePeriodEndsAt.getTime() - GRACE_PERIOD_DAYS[kind] * MILLIS_PER_DAY);
}

/** True once the grace window is over and the subscription must be suspended. */
export function isGraceExpired(gracePeriodEndsAt: Date, now: Date): boolean {
  return now.getTime() >= gracePeriodEndsAt.getTime();
}
