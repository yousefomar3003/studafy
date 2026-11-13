import { LIVE_STATUSES } from "@studafy/billing";
import { NOTIFICATION_TYPES } from "@studafy/constants";
import {
  isTemplateLocale,
  NOTIFICATION_CHANNELS,
  renderNotification,
} from "@studafy/notification-templates";

import { auditLicenseChange } from "./context";

import type { LicenseActor } from "./context";
import type { Audience, LicenseRecord } from "./service";
import type { Logger } from "../../logger";
import type { PaymentProviderPort } from "../subscriptions/ports/payment-provider";
import type { GooglePlayStore } from "../subscriptions/store/google";
import type { TemplateLocale } from "@studafy/notification-templates";
import type { TransactionSql } from "postgres";

/**
 * A seat given to someone who already pays personally (docs/billing/feature-licensing.md,
 * "People who already pay personally and then receive a school seat"):
 *
 *   - the school is owed a credit for the overlap -- the days the person's paid period and the seat
 *     both cover them -- priced at the seat's daily price, recorded for session 3's invoice;
 *   - the personal subscription stops renewing, so the person never pays twice: Stripe and Google
 *     Play are cancelled at period end through the provider, Tap (which we renew ourselves) is
 *     flagged locally, and an App Store purchaser -- whose renewal we cannot touch -- is sent an
 *     in-app notification with instructions;
 *   - nothing is refunded, and access is the best of both until the personal period ends.
 *
 * Runs when a seat starts covering its holder: on assignment to an active license, and for every
 * seat when a license is activated. One overlap row per (seat, personal subscription), so a re-run
 * (re-activation after a suspension) changes nothing. Unassigning a seat never touches the personal
 * subscription.
 */

const DAY_MS = 86_400_000;

/** A personal subscription's provider, as app.user_subscriptions spells it. */
export type PersonalProvider = "app_store" | "google_play" | "tap" | "stripe";

export interface OverlapCredit {
  overlapStartsAt: Date;
  overlapEndsAt: Date;
  /** Whole days, rounded up: a partial day of double coverage is a day the school is owed. */
  overlapDays: number;
  monthlySeatPriceMinor: number | null;
  /** monthly x 12 / 365, unrounded (stored to 6 places). */
  dailySeatPriceMinor: number | null;
  /** overlapDays x daily, rounded to the minor unit; 0 for an unpaid (trial) subscription. */
  creditMinor: number | null;
}

/**
 * The overlap credit for one seat and one personal subscription. Pure.
 *
 * The overlap runs from when the seat starts covering the person (now, or the license start if that
 * is later) to the end of the personal period, capped at the license end. The daily price is the
 * tier's monthly seat price spread over an average month (x 12 / 365), so a credit does not depend
 * on which month it falls in. A trial was never paid for, so it earns no credit.
 */
export function computeOverlapCredit(input: {
  now: Date;
  licenseStartsAt: Date;
  licenseEndsAt: Date;
  personalPeriodEnd: Date;
  monthlySeatPriceMinor: number | null;
  paid: boolean;
}): OverlapCredit {
  const start = Math.max(input.now.getTime(), input.licenseStartsAt.getTime());
  const end = Math.max(
    start,
    Math.min(input.personalPeriodEnd.getTime(), input.licenseEndsAt.getTime()),
  );
  const overlapDays = Math.ceil((end - start) / DAY_MS);

  if (input.monthlySeatPriceMinor === null) {
    return {
      overlapStartsAt: new Date(start),
      overlapEndsAt: new Date(end),
      overlapDays,
      monthlySeatPriceMinor: null,
      dailySeatPriceMinor: null,
      creditMinor: null,
    };
  }

  const daily = (input.monthlySeatPriceMinor * 12) / 365;
  return {
    overlapStartsAt: new Date(start),
    overlapEndsAt: new Date(end),
    overlapDays,
    monthlySeatPriceMinor: input.monthlySeatPriceMinor,
    dailySeatPriceMinor: Math.round(daily * 1_000_000) / 1_000_000,
    creditMinor: input.paid ? Math.round(overlapDays * daily) : 0,
  };
}

export type RenewalAction = "cancel_at_period_end" | "notify_user" | "none";

/** What to do about a personal subscription's renewal. Pure. */
export function renewalActionFor(
  provider: PersonalProvider | null,
  renewing: boolean,
): RenewalAction {
  if (!provider || !renewing) return "none";
  return provider === "app_store" ? "notify_user" : "cancel_at_period_end";
}

/** A seat that has just started covering its holder. */
export interface CoveringSeat {
  seatId: string;
  userId: string;
  studentId: string | null;
  audience: Audience;
}

interface PersonalSubscription {
  kind: "ai_subscription" | "user_subscription";
  id: string;
  seat: CoveringSeat;
  provider: PersonalProvider | null;
  /** Stripe subscription id, Google purchase token, Tap agreement, Apple original transaction. */
  providerReference: string | null;
  status: string;
  periodEnd: Date;
  renewing: boolean;
}

/** A renewal stop that needs a provider call, made after the seat's transaction commits. */
export interface PendingRenewalStop {
  overlapId: string;
  kind: PersonalSubscription["kind"];
  subscriptionId: string;
  provider: "stripe" | "google_play";
  providerReference: string;
}

const PAID_STATUSES = new Set(["active", "past_due", "grace_period"]);

async function loadPersonalSubscriptions(
  tx: TransactionSql,
  seats: readonly CoveringSeat[],
  now: Date,
): Promise<PersonalSubscription[]> {
  const live = [...LIVE_STATUSES];
  const byUser = new Map(seats.map((seat) => [`${seat.userId}:${seat.audience}`, seat]));
  const byStudent = new Map(
    seats.filter((seat) => seat.studentId).map((seat) => [seat.studentId!, seat]),
  );
  const found: PersonalSubscription[] = [];

  // Personal tier purchases of the seat's audience.
  const userRows = await tx<
    {
      id: string;
      user_id: string;
      audience: Audience;
      provider: PersonalProvider;
      provider_reference: string;
      status: string;
      current_period_end: Date;
      auto_renew: boolean;
    }[]
  >`
    SELECT us.id::text AS id, us.user_id::text AS user_id, p.audience, us.provider,
           us.provider_reference, us.status::text AS status, us.current_period_end, us.auto_renew
    FROM app.user_subscriptions AS us
    JOIN app.plans AS p ON p.id = us.plan_id
    WHERE us.school_id = current_setting('app.school_id')::uuid
      AND us.user_id = ANY(${seats.map((seat) => seat.userId)}::uuid[])
      AND us.status::text = ANY(${live})
      AND us.current_period_end > ${now}
  `;
  for (const row of userRows) {
    const seat = byUser.get(`${row.user_id}:${row.audience}`);
    if (!seat) continue;
    found.push({
      kind: "user_subscription",
      id: row.id,
      seat,
      provider: row.provider,
      providerReference: row.provider_reference,
      status: row.status,
      periodEnd: row.current_period_end,
      renewing: row.auto_renew,
    });
  }

  // The per-student AI add-on: every personal purchase made before tiers existed.
  if (byStudent.size === 0) return found;
  const aiRows = await tx<
    {
      id: string;
      student_id: string;
      status: string;
      current_period_end: Date;
      cancel_at_period_end: boolean;
      stripe_subscription_id: string | null;
      tap_payment_agreement_id: string | null;
    }[]
  >`
    SELECT id::text AS id, student_id::text AS student_id, status::text AS status,
           current_period_end, cancel_at_period_end, stripe_subscription_id, tap_payment_agreement_id
    FROM app.ai_subscriptions
    WHERE school_id = current_setting('app.school_id')::uuid
      AND student_id = ANY(${[...byStudent.keys()]}::uuid[])
      AND status::text = ANY(${live})
      AND current_period_end > ${now}
  `;

  // An add-on bought in an app store has no provider column; its billing event names the store.
  const storeless = aiRows
    .filter((row) => !row.stripe_subscription_id && !row.tap_payment_agreement_id)
    .map((row) => row.student_id);
  const stores = new Map<string, { platform: string; store_ref: string }>();
  if (storeless.length > 0) {
    const rows = await tx<{ student_id: string; platform: string; store_ref: string }[]>`
      SELECT student_id::text AS student_id, platform, store_ref
      FROM app.ai_store_purchases(${storeless}::uuid[])
    `;
    for (const row of rows) stores.set(row.student_id, row);
  }

  for (const row of aiRows) {
    const store = stores.get(row.student_id);
    const [provider, reference]: [PersonalProvider | null, string | null] =
      row.stripe_subscription_id
        ? ["stripe", row.stripe_subscription_id]
        : row.tap_payment_agreement_id
          ? ["tap", row.tap_payment_agreement_id]
          : store
            ? [store.platform === "apple" ? "app_store" : "google_play", store.store_ref]
            : [null, null];
    found.push({
      kind: "ai_subscription",
      id: row.id,
      seat: byStudent.get(row.student_id)!,
      provider,
      providerReference: reference,
      status: row.status,
      periodEnd: row.current_period_end,
      renewing: !row.cancel_at_period_end,
    });
  }

  return found;
}

/** The tier's monthly seat price in the license currency, per audience; null where unpriced. */
async function monthlySeatPrices(
  tx: TransactionSql,
  license: LicenseRecord,
): Promise<Record<Audience, number | null>> {
  const planIds = {
    student: license.studentPlanId,
    teacher: license.teacherPlanId,
    parent: license.parentPlanId,
  };
  const ids = Object.values(planIds).filter((id): id is string => id !== null);
  const rows =
    ids.length === 0
      ? []
      : await tx<{ plan_id: string; amount_minor: string }[]>`
          SELECT plan_id::text AS plan_id, amount_minor::text AS amount_minor
          FROM app.plan_prices
          WHERE plan_id = ANY(${ids}::uuid[])
            AND currency_id = ${license.currencyId}::uuid
            AND billing_interval = 'monthly'
            AND is_active
        `;
  const price = (planId: string | null) => {
    const row = rows.find((r) => r.plan_id === planId);
    return row ? Number(row.amount_minor) : null;
  };
  return {
    student: price(planIds.student),
    teacher: price(planIds.teacher),
    parent: price(planIds.parent),
  };
}

/**
 * Record the overlaps for seats that have just started covering their holders, in the seats'
 * transaction. Tap renewals are stopped and App Store purchasers notified here; Stripe and Google
 * Play stops need a provider call and are returned for {@link applyRenewalStops} after commit.
 */
export async function recordSeatOverlaps(
  tx: TransactionSql,
  input: {
    schoolId: string;
    license: LicenseRecord;
    seats: readonly CoveringSeat[];
    actor: LicenseActor;
    now?: Date;
  },
): Promise<PendingRenewalStop[]> {
  const { schoolId, license, seats, actor, now = new Date() } = input;
  if (seats.length === 0) return [];

  const personal = await loadPersonalSubscriptions(tx, seats, now);
  if (personal.length === 0) return [];

  const prices = await monthlySeatPrices(tx, license);
  const [school] = await tx<{ name: string }[]>`
    SELECT name FROM app.schools WHERE id = ${schoolId}::uuid
  `;
  const pending: PendingRenewalStop[] = [];

  for (const sub of personal) {
    const credit = computeOverlapCredit({
      now,
      licenseStartsAt: license.startsAt,
      licenseEndsAt: license.endsAt,
      personalPeriodEnd: sub.periodEnd,
      monthlySeatPriceMinor: prices[sub.seat.audience],
      paid: PAID_STATUSES.has(sub.status),
    });
    // Never leave a gap: a personal period that ends before the license starts keeps renewing.
    const gapless = sub.periodEnd.getTime() >= license.startsAt.getTime();
    const action = gapless ? renewalActionFor(sub.provider, sub.renewing) : "none";
    // Tap and App Store are settled in this transaction; Stripe and Google wait for the provider.
    const settledHere = action === "notify_user" || (action !== "none" && sub.provider === "tap");
    const status = action === "none" ? "not_needed" : settledHere ? "done" : "pending";

    const [overlap] = await tx<{ id: string }[]>`
      INSERT INTO app.license_seat_overlaps (
        school_id, license_id, seat_id, user_id, ai_subscription_id, user_subscription_id, provider,
        overlap_starts_at, overlap_ends_at, overlap_days, currency_id, monthly_seat_price_minor,
        daily_seat_price_minor, credit_minor, renewal_action, renewal_status
      ) VALUES (
        ${schoolId}::uuid, ${license.id}::uuid, ${sub.seat.seatId}::uuid, ${sub.seat.userId}::uuid,
        ${sub.kind === "ai_subscription" ? sub.id : null}::uuid,
        ${sub.kind === "user_subscription" ? sub.id : null}::uuid,
        ${sub.provider}, ${credit.overlapStartsAt}, ${credit.overlapEndsAt}, ${credit.overlapDays},
        ${license.currencyId}::uuid, ${credit.monthlySeatPriceMinor}, ${credit.dailySeatPriceMinor},
        ${credit.creditMinor}, ${action}, ${status}
      )
      ON CONFLICT DO NOTHING
      RETURNING id::text AS id
    `;
    // Already recorded (a re-activation): nothing more to do for this pair.
    if (!overlap) continue;

    await auditLicenseChange(tx, schoolId, actor, {
      action: "insert",
      targetTable: "license_seat_overlaps",
      targetId: overlap.id,
      newValues: {
        seat_id: sub.seat.seatId,
        [sub.kind === "ai_subscription" ? "ai_subscription_id" : "user_subscription_id"]: sub.id,
        provider: sub.provider,
        overlap_days: credit.overlapDays,
        credit_minor: credit.creditMinor,
        renewal_action: action,
        renewal_status: status,
      },
    });

    if (action === "notify_user") {
      await notifyAppleRenewal(tx, schoolId, sub.seat.userId, school?.name ?? "", sub.periodEnd);
    } else if (action === "cancel_at_period_end" && sub.provider === "tap") {
      await stopRenewalLocally(tx, schoolId, actor, sub.kind, sub.id);
    } else if (action === "cancel_at_period_end") {
      pending.push({
        overlapId: overlap.id,
        kind: sub.kind,
        subscriptionId: sub.id,
        provider: sub.provider as "stripe" | "google_play",
        providerReference: sub.providerReference!,
      });
    }
  }

  return pending;
}

/** Turn renewal off on our side: the Tap worker and the webhooks read these flags. */
async function stopRenewalLocally(
  tx: TransactionSql,
  schoolId: string,
  actor: LicenseActor,
  kind: PersonalSubscription["kind"],
  id: string,
): Promise<void> {
  if (kind === "ai_subscription") {
    await tx`
      UPDATE app.ai_subscriptions
      SET cancel_at_period_end = true, updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
      WHERE id = ${id}::uuid AND school_id = current_setting('app.school_id')::uuid
    `;
    await auditLicenseChange(tx, schoolId, actor, {
      action: "update",
      targetTable: "ai_subscriptions",
      targetId: id,
      oldValues: { cancel_at_period_end: false },
      newValues: { cancel_at_period_end: true },
    });
    return;
  }
  await tx`
    UPDATE app.user_subscriptions
    SET auto_renew = false, updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE id = ${id}::uuid AND school_id = current_setting('app.school_id')::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "user_subscriptions",
    targetId: id,
    oldValues: { auto_renew: true },
    newValues: { auto_renew: false },
  });
}

/**
 * The App Store notice. No RETURNING: app.notifications' SELECT policy is owner-only, so the id is
 * minted here (the messaging and announcements precedent).
 */
async function notifyAppleRenewal(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  schoolName: string,
  periodEnd: Date,
): Promise<void> {
  // Users carry no language of their own; the school's is what its other notices are written in.
  const [settings] = await tx<{ locale: string | null }[]>`
    SELECT locale FROM app.school_settings WHERE school_id = current_setting('app.school_id')::uuid
  `;
  const locale = isTemplateLocale(settings?.locale ?? "")
    ? (settings!.locale as TemplateLocale)
    : "en";
  const vars = { schoolName, periodEnd: periodEnd.toISOString().slice(0, 10) };
  const type = NOTIFICATION_TYPES.LICENSE_SEAT_APPLE_RENEWAL;

  await tx`
    INSERT INTO app.notifications (id, school_id, user_id, notification_type, title, body, metadata)
    VALUES (
      ${crypto.randomUUID()}::uuid,
      ${schoolId}::uuid,
      ${userId}::uuid,
      ${type}::app.notification_type,
      ${renderNotification(type, NOTIFICATION_CHANNELS.PUSH, locale, vars).trim()},
      ${renderNotification(type, NOTIFICATION_CHANNELS.IN_APP, locale, vars).trim()},
      ${tx.json({ period_end: vars.periodEnd })}
    )
  `;
}

/** The providers a renewal stop may call. Either may be absent in a deployment. */
export interface RenewalProviders {
  stripe: PaymentProviderPort | null;
  googlePlay: GooglePlayStore | null;
}

export interface RenewalStopOutcome {
  overlapId: string;
  status: "done" | "failed";
  error?: string;
}

/**
 * Make the provider calls {@link recordSeatOverlaps} deferred, then record each outcome. Runs after
 * the seats commit -- a provider call must never sit inside a database transaction -- so a failure
 * is recorded on the overlap row (renewal_status = failed) rather than undoing the seat. The super
 * admin console lists failed rows (session 4) to retry or follow up by hand.
 */
export async function applyRenewalStops(
  pending: readonly PendingRenewalStop[],
  deps: {
    providers: RenewalProviders;
    schoolId: string;
    actor: LicenseActor;
    logger: Logger;
    runInSchool: <T>(fn: (tx: TransactionSql) => Promise<T>) => Promise<T>;
  },
): Promise<RenewalStopOutcome[]> {
  const outcomes: RenewalStopOutcome[] = [];

  for (const stop of pending) {
    let error: string | null = null;
    try {
      if (stop.provider === "stripe") {
        if (!deps.providers.stripe) throw new Error("Stripe is not configured");
        await deps.providers.stripe.scheduleCancellation({
          providerSubscriptionId: stop.providerReference,
        });
      } else {
        if (!deps.providers.googlePlay) throw new Error("Google Play is not configured");
        await deps.providers.googlePlay.cancel(stop.providerReference);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      deps.logger.warn(
        { err, school_id: deps.schoolId, overlap_id: stop.overlapId, provider: stop.provider },
        "license seat: stopping a personal subscription's renewal failed",
      );
    }

    await deps.runInSchool(async (tx) => {
      await tx`
        UPDATE app.license_seat_overlaps
        SET renewal_status = ${error ? "failed" : "done"},
            renewal_error = ${error ? error.slice(0, 500) : null},
            updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
        WHERE id = ${stop.overlapId}::uuid
          AND school_id = current_setting('app.school_id')::uuid
      `;
      await auditLicenseChange(tx, deps.schoolId, deps.actor, {
        action: "update",
        targetTable: "license_seat_overlaps",
        targetId: stop.overlapId,
        oldValues: { renewal_status: "pending" },
        newValues: { renewal_status: error ? "failed" : "done" },
      });
      if (!error) {
        await stopRenewalLocally(tx, deps.schoolId, deps.actor, stop.kind, stop.subscriptionId);
      }
    });

    outcomes.push({
      overlapId: stop.overlapId,
      status: error ? "failed" : "done",
      ...(error ? { error } : {}),
    });
  }

  return outcomes;
}
