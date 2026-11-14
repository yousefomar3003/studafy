/**
 * The paid storage add-on (db/migrations/000205): what a school can buy, and changing or ending what
 * it bought. Buying goes through `createStorageCheckoutSession` (checkout-service.ts), like every
 * other checkout; the webhook pipeline (packages/billing, kind `storage`) creates and moves the row.
 *
 * The school's upload cap is never written here or by billing: the quota check reads the larger of
 * the included cap and a live add-on's cap (storage/quota-service.ts). So a tier change only has to
 * move `cap_bytes` on the add-on row, and an add-on that ends just stops counting -- nothing a school
 * stored is ever deleted.
 *
 * Bought, changed and canceled online only through Stripe, which keeps the subscription and prorates
 * a change. Tap has no subscription object (Studafy renews Tap charges itself), so a school billed
 * through Tap is told the add-on is not available online instead of being sold one nobody renews.
 */

import { LIVE_STATUSES } from "@studafy/billing";
import {
  ERROR_CODES,
  INCLUDED_STORAGE_BYTES,
  isStorageAddonPlanCode,
  STORAGE_ADDON_PLAN_CODES,
  STORAGE_ADDON_TIERS,
} from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { findStorageGrantInForce, getStorageUsage } from "../../storage/quota-service";
import { selectPaymentProviderForSchool } from "../payment-provider-routing";

import type { Database } from "../../../db";
import type { TenantContext } from "../../../db/tenant-tx";
import type { PaymentProviderRegistry, SelectedPaymentProvider } from "../payment-provider-routing";
import type { PaymentMethodSummary, SubscriptionInvoiceSummary } from "../ports/payment-provider";
import type { StorageAddonPlanCode, SubscriptionStatus } from "@studafy/constants";
import type { TransactionSql } from "postgres";

/** The currency a school is offered when no price exists in its own. */
const FALLBACK_CURRENCY = "USD";

export interface StorageAddonPrice {
  id: string;
  amountMinor: number;
  currency: string;
  interval: "monthly" | "yearly";
}

export interface StorageAddonTier {
  planCode: StorageAddonPlanCode;
  capBytes: number;
  /** This tier's prices in the offered currency, monthly first. Empty when none is set. */
  prices: StorageAddonPrice[];
}

export interface StoragePendingChange {
  planCode: StorageAddonPlanCode | null;
  capBytes: number;
  price: StorageAddonPrice | null;
  /** When it takes effect: the add-on's next renewal. */
  effectiveAt: Date;
}

export interface StorageAddonCurrent {
  planCode: StorageAddonPlanCode | null;
  capBytes: number;
  status: SubscriptionStatus;
  price: StorageAddonPrice | null;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** A move to less storage or to the other interval, waiting for the next renewal. */
  pendingChange: StoragePendingChange | null;
}

export interface StorageOffer {
  usage: { usedBytes: number; capBytes: number; includedBytes: number };
  /** The school's live add-on, or null when it has none. */
  current: StorageAddonCurrent | null;
  tiers: StorageAddonTier[];
  /** The currency `tiers` are priced in; null when no storage price exists at all. */
  currency: string | null;
  /** Whether this school can buy, change or cancel online (its provider is Stripe and configured). */
  availableOnline: boolean;
  /**
   * Storage Studafy granted by hand (a cash payment, a pilot) that is in force now, or null
   * (app.manual_grants, 000211).
   */
  granted: { capBytes: number; endsAt: Date } | null;
}

interface PriceRow {
  id: string;
  plan_code: string;
  amount_minor: string;
  currency: string;
  billing_interval: "monthly" | "yearly";
  stripe_price_id: string | null;
}

interface StorageRow {
  id: string;
  plan_price_id: string | null;
  cap_bytes: string;
  status: SubscriptionStatus;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  stripe_subscription_id: string | null;
  pending_plan_price_id: string | null;
  pending_cap_bytes: string | null;
  pending_effective_at: Date | null;
  stripe_schedule_id: string | null;
}

/** A plan price by id, active or not (the add-on's own price may have been retired since). */
async function readPrice(
  tx: TransactionSql,
  priceId: string | null,
): Promise<PriceRow | undefined> {
  if (!priceId) return undefined;
  const [row] = await tx<PriceRow[]>`
    SELECT pp.id, p.code AS plan_code, pp.amount_minor::text AS amount_minor,
           cur.code AS currency, pp.billing_interval::text AS billing_interval,
           pp.stripe_price_id
    FROM app.plan_prices pp
    JOIN app.plans p ON p.id = pp.plan_id
    JOIN app.currencies cur ON cur.id = pp.currency_id
    WHERE pp.id = ${priceId}::uuid
  `;
  return row;
}

/** The add-on row as the school sees it, with its price and any change scheduled for renewal. */
export async function describeStorageAddon(
  tx: TransactionSql,
  live: StorageRow,
): Promise<StorageAddonCurrent> {
  const price = await readPrice(tx, live.plan_price_id);
  const pendingPrice = await readPrice(tx, live.pending_plan_price_id);
  return {
    planCode: price && isStorageAddonPlanCode(price.plan_code) ? price.plan_code : null,
    capBytes: Number(live.cap_bytes),
    status: live.status,
    price: price ? toPrice(price) : null,
    currentPeriodEnd: live.current_period_end,
    cancelAtPeriodEnd: live.cancel_at_period_end,
    pendingChange:
      live.pending_plan_price_id && live.pending_effective_at
        ? {
            planCode:
              pendingPrice && isStorageAddonPlanCode(pendingPrice.plan_code)
                ? pendingPrice.plan_code
                : null,
            capBytes: Number(live.pending_cap_bytes),
            price: pendingPrice ? toPrice(pendingPrice) : null,
            effectiveAt: live.pending_effective_at,
          }
        : null,
  };
}

function toPrice(row: PriceRow): StorageAddonPrice {
  return {
    id: row.id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    interval: row.billing_interval,
  };
}

/** A storage plan's active price by id, or undefined when the id is not one. */
export async function findStoragePrice(
  tx: TransactionSql,
  priceId: string,
): Promise<PriceRow | undefined> {
  const [row] = await tx<PriceRow[]>`
    SELECT pp.id, p.code AS plan_code, pp.amount_minor::text AS amount_minor, cur.code AS currency,
           pp.billing_interval::text AS billing_interval, pp.stripe_price_id
    FROM app.plan_prices pp
    JOIN app.plans p ON p.id = pp.plan_id
    JOIN app.currencies cur ON cur.id = pp.currency_id
    WHERE pp.id = ${priceId}::uuid
      AND pp.is_active AND p.is_active
      AND p.code = ANY(${STORAGE_ADDON_PLAN_CODES})
    LIMIT 1
  `;
  return row;
}

const STORAGE_COLUMNS = (tx: TransactionSql) => tx`
  id, plan_price_id, cap_bytes::text AS cap_bytes, status::text AS status, current_period_end,
  cancel_at_period_end, stripe_subscription_id, pending_plan_price_id,
  pending_cap_bytes::text AS pending_cap_bytes, pending_effective_at, stripe_schedule_id
`;

/** The school's live storage add-on row, locked when `forUpdate`. */
export async function findLiveStorageAddon(
  tx: TransactionSql,
  schoolId: string,
  forUpdate = false,
): Promise<StorageRow | undefined> {
  const rows = forUpdate
    ? await tx<StorageRow[]>`
        SELECT ${STORAGE_COLUMNS(tx)}
        FROM app.storage_subscriptions
        WHERE school_id = ${schoolId}::uuid AND status::text = ANY(${[...LIVE_STATUSES]})
        FOR UPDATE
      `
    : await tx<StorageRow[]>`
        SELECT ${STORAGE_COLUMNS(tx)}
        FROM app.storage_subscriptions
        WHERE school_id = ${schoolId}::uuid AND status::text = ANY(${[...LIVE_STATUSES]})
      `;
  return rows[0];
}

/**
 * Whether the provider can sell the add-on with every safeguard: change it for a previewed amount,
 * and see (and close) purchases still on their way, so a school is never charged twice.
 */
function sellsStorageOnline(selected: SelectedPaymentProvider): boolean {
  const port = selected.port;
  return (
    selected.name === "stripe" &&
    port.changeSubscriptionPrice !== undefined &&
    port.previewSubscriptionPriceChange !== undefined &&
    port.findAddonPurchasesInFlight !== undefined &&
    port.expireCheckoutSession !== undefined &&
    port.scheduleSubscriptionPriceChange !== undefined &&
    port.releaseSubscriptionSchedule !== undefined &&
    port.countPendingInvoiceItems !== undefined
  );
}

/** The school's provider when it can sell the add-on online (Stripe), else null. Never throws for a
 * missing or unsupported provider: the offer reports it rather than failing the page. */
async function onlineProvider(
  tx: TransactionSql,
  providers: PaymentProviderRegistry,
  schoolId: string,
): Promise<SelectedPaymentProvider | null> {
  try {
    const selected = await selectPaymentProviderForSchool(tx, providers, schoolId);
    return sellsStorageOnline(selected) ? selected : null;
  } catch {
    return null;
  }
}

/**
 * What the school can buy: its usage and cap, its live add-on if any, and each tier's prices in the
 * school's own currency (USD when no storage price is set in it).
 */
export async function getStorageOffer(
  database: Database,
  providers: PaymentProviderRegistry,
  context: TenantContext & { schoolId: string },
): Promise<StorageOffer> {
  return withTenantTx(database, context, async (tx) => {
    const usage = await getStorageUsage(tx);

    const prices = await tx<(PriceRow & { is_school_currency: boolean })[]>`
      SELECT pp.id, p.code AS plan_code, pp.amount_minor::text AS amount_minor, cur.code AS currency,
             pp.billing_interval::text AS billing_interval, pp.stripe_price_id,
             (cur.id = s.default_currency_id) AS is_school_currency
      FROM app.plan_prices pp
      JOIN app.plans p ON p.id = pp.plan_id
      JOIN app.currencies cur ON cur.id = pp.currency_id
      JOIN app.schools s ON s.id = ${context.schoolId}::uuid
      WHERE pp.is_active AND p.is_active AND p.code = ANY(${STORAGE_ADDON_PLAN_CODES})
      ORDER BY (pp.billing_interval = 'monthly') DESC, pp.amount_minor
    `;
    const currency =
      prices.find((price) => price.is_school_currency)?.currency ??
      (prices.some((price) => price.currency === FALLBACK_CURRENCY) ? FALLBACK_CURRENCY : null);

    const tiers = STORAGE_ADDON_PLAN_CODES.map((planCode) => ({
      planCode,
      capBytes: STORAGE_ADDON_TIERS[planCode].capBytes,
      prices: prices
        .filter((price) => price.plan_code === planCode && price.currency === currency)
        .map(toPrice),
    }));

    const live = await findLiveStorageAddon(tx, context.schoolId);
    const current = live ? await describeStorageAddon(tx, live) : null;

    return {
      usage: {
        usedBytes: usage.bytesUsed,
        capBytes: usage.capBytes,
        includedBytes: INCLUDED_STORAGE_BYTES,
      },
      current,
      tiers,
      currency,
      availableOnline: (await onlineProvider(tx, providers, context.schoolId)) !== null,
      granted: await findStorageGrantInForce(tx),
    };
  });
}

function unavailable(): CodedHttpException {
  return new CodedHttpException(
    409,
    ERROR_CODES.STORAGE_ADDON_UNAVAILABLE,
    "The storage add-on cannot be bought or changed online for this school",
  );
}

function notActive(): CodedHttpException {
  return new CodedHttpException(
    409,
    ERROR_CODES.STORAGE_ADDON_NOT_ACTIVE,
    "The school has no live storage add-on",
  );
}

/** The selected provider, only when it can manage the add-on online. */
export async function requireOnlineStorageProvider(
  tx: TransactionSql,
  providers: PaymentProviderRegistry,
  schoolId: string,
): Promise<SelectedPaymentProvider> {
  // Run the real selection first so a demo school or an unconfigured provider answers with its own
  // error, as every other checkout does.
  const selected = await selectPaymentProviderForSchool(tx, providers, schoolId);
  if (!sellsStorageOnline(selected)) throw unavailable();
  return selected;
}

/** How long a confirmed preview may be used to change tier. */
export const STORAGE_CHANGE_PREVIEW_TTL_MS = 30 * 60 * 1000;

/**
 * When a change takes effect, as the app stores do it: more storage on the same billing interval
 * starts now with one prorated charge; less storage, or the other interval, starts at the next
 * renewal with nothing charged or credited now.
 */
export type StorageChangeTiming = "now" | "renewal";

interface PreparedChange {
  selected: SelectedPaymentProvider;
  live: StorageRow & { stripe_subscription_id: string };
  next: PriceRow & { plan_code: StorageAddonPlanCode; stripe_price_id: string };
  capBytes: number;
  timing: StorageChangeTiming;
}

function changePending(): CodedHttpException {
  return new CodedHttpException(
    409,
    ERROR_CODES.STORAGE_ADDON_CHANGE_PENDING,
    "A storage change is already scheduled for the next renewal",
  );
}

function unsettled(message: string): CodedHttpException {
  return new CodedHttpException(409, ERROR_CODES.STORAGE_ADDON_UNSETTLED, message);
}

/** The school's provider customer, or null when it has none yet. */
async function stripeCustomerOf(tx: TransactionSql, schoolId: string): Promise<string | null> {
  const [row] = await tx<{ stripe_customer_id: string | null }[]>`
    SELECT stripe_customer_id FROM app.schools WHERE id = ${schoolId}::uuid
  `;
  return row?.stripe_customer_id ?? null;
}

/**
 * Everything a tier change and its preview both check, with the live row locked: one change at a
 * time, nothing owed, and nothing left over from an earlier change that the provider's preview would
 * count but an immediate change would not (the cause of a preview of 0 followed by a real charge).
 */
async function prepareChange(
  tx: TransactionSql,
  providers: PaymentProviderRegistry,
  schoolId: string,
  priceId: string,
): Promise<PreparedChange> {
  const selected = await requireOnlineStorageProvider(tx, providers, schoolId);

  const live = await findLiveStorageAddon(tx, schoolId, true);
  if (!live || !live.stripe_subscription_id) throw notActive();
  if (live.pending_plan_price_id) throw changePending();
  if (live.status !== "active" && live.status !== "trialing") {
    throw unsettled("The storage add-on has a payment due");
  }

  const next = await findStoragePrice(tx, priceId);
  if (!next || !isStorageAddonPlanCode(next.plan_code)) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
      "Selected price is not available",
    );
  }
  if (!next.stripe_price_id) throw unavailable();

  const currentPrice = await readPrice(tx, live.plan_price_id);
  if (currentPrice?.id === next.id) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.STORAGE_ADDON_ALREADY_ACTIVE,
      "The school is already on this storage tier",
    );
  }
  // A Stripe subscription is billed in one currency for its whole life.
  if (currentPrice && currentPrice.currency !== next.currency) throw unavailable();

  const customerId = await stripeCustomerOf(tx, schoolId);
  if (customerId) {
    const pending = await selected.port.countPendingInvoiceItems!(customerId);
    if (pending.count > 0) {
      throw unsettled("An amount from an earlier change is waiting for the next invoice");
    }
  }

  const capBytes = STORAGE_ADDON_TIERS[next.plan_code].capBytes;
  const sameInterval =
    currentPrice === undefined || currentPrice.billing_interval === next.billing_interval;
  const timing: StorageChangeTiming =
    capBytes > Number(live.cap_bytes) && sameInterval ? "now" : "renewal";

  return {
    selected,
    live: { ...live, stripe_subscription_id: live.stripe_subscription_id },
    next: { ...next, plan_code: next.plan_code, stripe_price_id: next.stripe_price_id },
    capBytes,
    timing,
  };
}

export interface StorageChangePreview {
  /** "now": applied and charged at once. "renewal": applied at the next renewal, nothing now. */
  timing: StorageChangeTiming;
  /** When the new storage starts: now, or the next renewal. */
  effectiveAt: Date;
  /** Charged the moment the change is confirmed; 0 for a change at renewal. */
  amountDueNowMinor: number;
  /** The next regular bill, at the new price. */
  nextBillMinor: number;
  nextBillAt: Date;
  currency: string;
  /** Kept for older clients: true when something is charged now. */
  chargeNow: boolean;
  price: StorageAddonPrice;
  capBytes: number;
  /** The instant the proration is computed at: send it back with the change. */
  prorationDate: Date;
}

/**
 * What a tier change will cost. For a change now, from the provider's own preview of the invoice --
 * nothing is charged or changed -- and the change must quote `prorationDate` and
 * `amountDueNowMinor` back, so the school is charged exactly the amount it was shown. A change at
 * renewal costs nothing now, and the next bill is the new price.
 */
export async function previewStorageTierChange(
  database: Database,
  providers: PaymentProviderRegistry,
  params: { schoolId: string; priceId: string; tenantContext: TenantContext },
): Promise<StorageChangePreview> {
  const { schoolId, priceId, tenantContext } = params;

  return withTenantTx(database, tenantContext, async (tx) => {
    const change = await prepareChange(tx, providers, schoolId, priceId);
    const prorationDate = new Date(Math.floor(Date.now() / 1000) * 1000);
    const price = toPrice(change.next);

    if (change.timing === "renewal") {
      return {
        timing: "renewal",
        effectiveAt: change.live.current_period_end,
        amountDueNowMinor: 0,
        nextBillMinor: price.amountMinor,
        nextBillAt: change.live.current_period_end,
        currency: price.currency,
        chargeNow: false,
        price,
        capBytes: change.capBytes,
        prorationDate,
      };
    }

    const preview = await change.selected.port.previewSubscriptionPriceChange!({
      providerSubscriptionId: change.live.stripe_subscription_id,
      priceId: change.next.stripe_price_id,
      chargeNow: true,
      prorationDate: prorationDate.getTime() / 1000,
    });

    return {
      timing: "now",
      effectiveAt: prorationDate,
      amountDueNowMinor: preview.amountDueMinor,
      nextBillMinor: price.amountMinor,
      nextBillAt: change.live.current_period_end,
      currency: preview.currency,
      chargeNow: preview.amountDueMinor > 0,
      price,
      capBytes: change.capBytes,
      prorationDate,
    };
  });
}

export interface ChangeStorageTierParams {
  schoolId: string;
  priceId: string;
  /** From the preview the school confirmed. */
  prorationDate: Date;
  /** The amount due now that the school confirmed (`amountDueNowMinor` of the preview). */
  expectedAmountMinor: number;
  /** One per confirmation: a repeat of the same request never charges twice. */
  requestKey: string;
  tenantContext: TenantContext;
}

function priceChanged(): CodedHttpException {
  return new CodedHttpException(
    409,
    ERROR_CODES.STORAGE_ADDON_PRICE_CHANGED,
    "The amount for this change is no longer the one confirmed; nothing was charged",
  );
}

/**
 * Refund at once whatever an immediate change took beyond the amount the school confirmed, and
 * record it for the super admin. A failed refund is recorded as `needs_review`, never thrown: the
 * change itself has been paid and applied, and the school must see it.
 */
async function settleOvercharge(
  tx: TransactionSql,
  selected: SelectedPaymentProvider,
  params: {
    schoolId: string;
    storageSubscriptionId: string;
    invoice: { id: string; amountPaidMinor: number; currency: string };
    expectedMinor: number;
    requestKey: string;
  },
): Promise<void> {
  const { schoolId, storageSubscriptionId, invoice, expectedMinor, requestKey } = params;
  const excess = invoice.amountPaidMinor - expectedMinor;
  if (excess <= 0) return;

  let refundId: string | null = null;
  let error: string | null = null;
  try {
    const refund = await selected.port.refund({
      invoiceId: invoice.id,
      amountMinor: excess,
      currency: invoice.currency,
      idempotencyKey: `storage-overcharge:${invoice.id}:${requestKey}`,
      metadata: {
        school_id: schoolId,
        reason: "storage_change_overcharge",
        storage_subscription_id: storageSubscriptionId,
      },
    });
    refundId = refund.providerRefundId;
  } catch (caught) {
    error = (caught instanceof Error ? caught.message : String(caught)).slice(0, 500);
  }

  const status = refundId ? "refunded" : "needs_review";
  await tx`
    INSERT INTO app.storage_billing_incidents (
      school_id, storage_subscription_id, kind, stripe_invoice_id, expected_minor, charged_minor,
      refund_minor, currency, stripe_refund_id, status, last_error, resolved_at
    ) VALUES (
      ${schoolId}::uuid, ${storageSubscriptionId}::uuid, 'overcharge', ${invoice.id},
      ${expectedMinor}, ${invoice.amountPaidMinor}, ${excess}, ${invoice.currency}, ${refundId},
      ${status}, ${error}, ${refundId ? new Date() : null}
    )
    ON CONFLICT (stripe_invoice_id, kind) DO NOTHING
  `;
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "storage_billing_incidents",
    targetId: storageSubscriptionId,
    newValues: {
      stripe_invoice_id: invoice.id,
      expected_minor: expectedMinor,
      charged_minor: invoice.amountPaidMinor,
      refund_minor: excess,
      stripe_refund_id: refundId,
      status,
    },
  });
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "storage change charged more than confirmed",
      schoolId,
      invoiceId: invoice.id,
      expectedMinor,
      chargedMinor: invoice.amountPaidMinor,
      refunded: refundId !== null,
    }),
  );
}

/**
 * Change the school's storage tier, the way the app stores do.
 *
 * More storage on the same interval applies now, for exactly the amount the school confirmed: the
 * preview is recomputed at the confirmed `prorationDate` and must still match `expectedAmountMinor`
 * (409 STORAGE_ADDON_PRICE_CHANGED, nothing charged, otherwise); the invoice Stripe then creates is
 * read back, and anything it took beyond the confirmed amount is refunded at once and recorded
 * (settleOvercharge). A declined card answers 402 and changes nothing.
 *
 * Less storage, or the other interval, is scheduled for the next renewal: nothing is charged or
 * credited now, the school keeps its current storage until then, and the webhook pipeline moves the
 * row when the new price starts. Undo it with `undoScheduledStorageChange`.
 *
 * The live row stays locked from the checks to the write, so a double click or a second tab waits
 * and then finds the change already made, and every provider call carries an idempotency key.
 */
export async function changeStorageTier(
  database: Database,
  providers: PaymentProviderRegistry,
  params: ChangeStorageTierParams,
): Promise<StorageAddonCurrent> {
  const { schoolId, priceId, prorationDate, expectedAmountMinor, requestKey, tenantContext } =
    params;

  const age = Date.now() - prorationDate.getTime();
  if (age > STORAGE_CHANGE_PREVIEW_TTL_MS || age < -60_000) throw priceChanged();

  return withTenantTx(database, tenantContext, async (tx) => {
    const change = await prepareChange(tx, providers, schoolId, priceId);
    const { selected, live, next, capBytes } = change;
    const metadata = { price_id: next.id, billing_interval: next.billing_interval };

    if (change.timing === "renewal") {
      if (expectedAmountMinor !== 0) throw priceChanged();
      const scheduled = await selected.port.scheduleSubscriptionPriceChange!({
        providerSubscriptionId: live.stripe_subscription_id,
        priceId: next.stripe_price_id,
        metadata,
        idempotencyKey: `storage-schedule:${live.id}:${requestKey}`,
      });

      await tx`
        UPDATE app.storage_subscriptions
        SET pending_plan_price_id = ${next.id}::uuid, pending_cap_bytes = ${capBytes},
            pending_effective_at = ${scheduled.effectiveAt},
            stripe_schedule_id = ${scheduled.scheduleId},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${live.id}::uuid
      `;
      await emitAuditLog(tx, {
        action: "update",
        targetTable: "storage_subscriptions",
        targetId: live.id,
        oldValues: { pending_plan_price_id: null },
        newValues: {
          pending_plan_price_id: next.id,
          pending_cap_bytes: capBytes,
          pending_effective_at: scheduled.effectiveAt.toISOString(),
          stripe_schedule_id: scheduled.scheduleId,
        },
      });

      const [updated] = await tx<StorageRow[]>`
        SELECT ${STORAGE_COLUMNS(tx)} FROM app.storage_subscriptions WHERE id = ${live.id}::uuid
      `;
      return describeStorageAddon(tx, updated!);
    }

    const prorationSeconds = Math.floor(prorationDate.getTime() / 1000);
    const preview = await selected.port.previewSubscriptionPriceChange!({
      providerSubscriptionId: live.stripe_subscription_id,
      priceId: next.stripe_price_id,
      chargeNow: true,
      prorationDate: prorationSeconds,
    });
    if (preview.amountDueMinor !== expectedAmountMinor) throw priceChanged();

    const result = await selected.port.changeSubscriptionPrice!({
      providerSubscriptionId: live.stripe_subscription_id,
      priceId: next.stripe_price_id,
      chargeNow: true,
      prorationDate: prorationSeconds,
      idempotencyKey: `storage-change:${live.id}:${requestKey}`,
      metadata,
    });

    if (!result.applied) {
      throw new CodedHttpException(
        402,
        ERROR_CODES.STORAGE_ADDON_PAYMENT_FAILED,
        "The payment for the storage change did not go through; nothing was changed",
      );
    }

    const currentCap = Number(live.cap_bytes);
    await tx`
      UPDATE app.storage_subscriptions
      SET plan_price_id = ${next.id}::uuid, cap_bytes = ${capBytes},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${live.id}::uuid
    `;

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "storage_subscriptions",
      targetId: live.id,
      oldValues: { plan_price_id: live.plan_price_id, cap_bytes: currentCap },
      newValues: {
        plan_price_id: next.id,
        cap_bytes: capBytes,
        confirmed_minor: expectedAmountMinor,
        charged_minor: result.invoice?.amountPaidMinor ?? null,
        stripe_invoice_id: result.invoice?.id ?? null,
        currency: preview.currency,
      },
    });

    if (result.invoice) {
      await settleOvercharge(tx, selected, {
        schoolId,
        storageSubscriptionId: live.id,
        invoice: result.invoice,
        expectedMinor: expectedAmountMinor,
        requestKey,
      });
    }

    const [updated] = await tx<StorageRow[]>`
      SELECT ${STORAGE_COLUMNS(tx)} FROM app.storage_subscriptions WHERE id = ${live.id}::uuid
    `;
    return describeStorageAddon(tx, updated!);
  });
}

/** Release the provider's schedule and clear the scheduled change on the row (row locked). */
async function dropScheduledChange(
  tx: TransactionSql,
  selected: SelectedPaymentProvider,
  live: StorageRow,
): Promise<void> {
  if (!live.stripe_schedule_id) return;
  await selected.port.releaseSubscriptionSchedule!(live.stripe_schedule_id);
  await tx`
    UPDATE app.storage_subscriptions
    SET pending_plan_price_id = NULL, pending_cap_bytes = NULL, pending_effective_at = NULL,
        stripe_schedule_id = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${live.id}::uuid
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "storage_subscriptions",
    targetId: live.id,
    oldValues: {
      pending_plan_price_id: live.pending_plan_price_id,
      stripe_schedule_id: live.stripe_schedule_id,
    },
    newValues: { pending_plan_price_id: null, stripe_schedule_id: null },
  });
}

/** Undo the change scheduled for the next renewal: the add-on carries on as it is. */
export async function undoScheduledStorageChange(
  database: Database,
  providers: PaymentProviderRegistry,
  params: { schoolId: string; tenantContext: TenantContext },
): Promise<StorageAddonCurrent> {
  return withTenantTx(database, params.tenantContext, async (tx) => {
    const selected = await requireOnlineStorageProvider(tx, providers, params.schoolId);
    const live = await findLiveStorageAddon(tx, params.schoolId, true);
    if (!live) throw notActive();
    if (!live.pending_plan_price_id) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.STORAGE_ADDON_NO_PENDING_CHANGE,
        "No storage change is scheduled",
      );
    }
    await dropScheduledChange(tx, selected, live);
    return describeStorageAddon(tx, {
      ...live,
      pending_plan_price_id: null,
      pending_cap_bytes: null,
      pending_effective_at: null,
      stripe_schedule_id: null,
    });
  });
}

/**
 * Stop the add-on renewing (`cancel: true`) or undo that (`cancel: false`). It stays live, and its
 * cap with it, until the period ends; Stripe's `customer.subscription.deleted` then ends it through
 * the state machine and the school is back on its included storage, files untouched. Canceling also
 * drops any change scheduled for the renewal that will no longer happen.
 */
export async function setStorageAddonCancellation(
  database: Database,
  providers: PaymentProviderRegistry,
  params: { schoolId: string; cancel: boolean; tenantContext: TenantContext },
): Promise<{ cancelAtPeriodEnd: boolean; currentPeriodEnd: Date }> {
  const { schoolId, cancel, tenantContext } = params;

  return withTenantTx(database, tenantContext, async (tx) => {
    const selected = await requireOnlineStorageProvider(tx, providers, schoolId);

    const live = await findLiveStorageAddon(tx, schoolId, true);
    if (!live || !live.stripe_subscription_id) throw notActive();

    if (live.cancel_at_period_end !== cancel) {
      if (cancel) {
        // A subscription held by a schedule cannot be set to cancel: release it first.
        await dropScheduledChange(tx, selected, live);
        await selected.port.scheduleCancellation({
          providerSubscriptionId: live.stripe_subscription_id,
        });
      } else {
        await selected.port.reverseCancellation({
          providerSubscriptionId: live.stripe_subscription_id,
        });
      }

      await tx`
        UPDATE app.storage_subscriptions
        SET cancel_at_period_end = ${cancel}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${live.id}::uuid
      `;

      await emitAuditLog(tx, {
        action: "update",
        targetTable: "storage_subscriptions",
        targetId: live.id,
        oldValues: { cancel_at_period_end: live.cancel_at_period_end },
        newValues: { cancel_at_period_end: cancel },
      });
    }

    return { cancelAtPeriodEnd: cancel, currentPeriodEnd: live.current_period_end };
  });
}

export interface StorageBillingDetails {
  paymentMethod: PaymentMethodSummary | null;
  nextBill: { amountMinor: number; currency: string; at: Date } | null;
  invoices: SubscriptionInvoiceSummary[];
}

/** The live add-on's payment method, next bill and invoices, or null when it has none. */
export async function getStorageBilling(
  database: Database,
  providers: PaymentProviderRegistry,
  params: { schoolId: string; tenantContext: TenantContext },
): Promise<StorageBillingDetails | null> {
  return withTenantTx(database, params.tenantContext, async (tx) => {
    const selected = await requireOnlineStorageProvider(tx, providers, params.schoolId);
    const [row] = await tx<{ stripe_subscription_id: string | null }[]>`
      SELECT stripe_subscription_id FROM app.storage_subscriptions
      WHERE school_id = ${params.schoolId}::uuid
    `;
    if (!row?.stripe_subscription_id || !selected.port.describeSubscriptionBilling) return null;
    return selected.port.describeSubscriptionBilling(row.stripe_subscription_id);
  });
}

/** A hosted page where the school replaces the card its storage is paid with, and nothing else. */
export async function createStoragePaymentMethodSession(
  database: Database,
  providers: PaymentProviderRegistry,
  params: { schoolId: string; returnUrl: string; tenantContext: TenantContext },
): Promise<{ url: string }> {
  return withTenantTx(database, params.tenantContext, async (tx) => {
    const selected = await requireOnlineStorageProvider(tx, providers, params.schoolId);
    const live = await findLiveStorageAddon(tx, params.schoolId);
    const customerId = await stripeCustomerOf(tx, params.schoolId);
    if (!live || !customerId) throw notActive();
    if (!selected.port.createPaymentMethodPortalSession) throw unavailable();
    return selected.port.createPaymentMethodPortalSession({
      customerId,
      returnUrl: params.returnUrl,
    });
  });
}
