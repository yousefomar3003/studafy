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

export interface StorageAddonCurrent {
  planCode: StorageAddonPlanCode | null;
  capBytes: number;
  status: SubscriptionStatus;
  price: StorageAddonPrice | null;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
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

/** The school's live storage add-on row, locked when `forUpdate`. */
export async function findLiveStorageAddon(
  tx: TransactionSql,
  schoolId: string,
  forUpdate = false,
): Promise<StorageRow | undefined> {
  const rows = forUpdate
    ? await tx<StorageRow[]>`
        SELECT id, plan_price_id, cap_bytes::text AS cap_bytes, status::text AS status,
               current_period_end, cancel_at_period_end, stripe_subscription_id
        FROM app.storage_subscriptions
        WHERE school_id = ${schoolId}::uuid AND status::text = ANY(${[...LIVE_STATUSES]})
        FOR UPDATE
      `
    : await tx<StorageRow[]>`
        SELECT id, plan_price_id, cap_bytes::text AS cap_bytes, status::text AS status,
               current_period_end, cancel_at_period_end, stripe_subscription_id
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
    port.expireCheckoutSession !== undefined
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
    let current: StorageAddonCurrent | null = null;
    if (live) {
      const [price] = live.plan_price_id
        ? await tx<PriceRow[]>`
            SELECT pp.id, p.code AS plan_code, pp.amount_minor::text AS amount_minor,
                   cur.code AS currency, pp.billing_interval::text AS billing_interval,
                   pp.stripe_price_id
            FROM app.plan_prices pp
            JOIN app.plans p ON p.id = pp.plan_id
            JOIN app.currencies cur ON cur.id = pp.currency_id
            WHERE pp.id = ${live.plan_price_id}::uuid
          `
        : [];
      current = {
        planCode: price && isStorageAddonPlanCode(price.plan_code) ? price.plan_code : null,
        capBytes: Number(live.cap_bytes),
        status: live.status,
        price: price ? toPrice(price) : null,
        currentPeriodEnd: live.current_period_end,
        cancelAtPeriodEnd: live.cancel_at_period_end,
      };
    }

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

interface PreparedChange {
  selected: SelectedPaymentProvider;
  live: StorageRow & { stripe_subscription_id: string };
  next: PriceRow & { plan_code: StorageAddonPlanCode; stripe_price_id: string };
  capBytes: number;
  chargeNow: boolean;
  intervalChanges: boolean;
}

/** Everything a tier change and its preview both check, with the live row locked. */
async function prepareChange(
  tx: TransactionSql,
  providers: PaymentProviderRegistry,
  schoolId: string,
  priceId: string,
): Promise<PreparedChange> {
  const selected = await requireOnlineStorageProvider(tx, providers, schoolId);

  const live = await findLiveStorageAddon(tx, schoolId, true);
  if (!live || !live.stripe_subscription_id) throw notActive();

  const next = await findStoragePrice(tx, priceId);
  if (!next || !isStorageAddonPlanCode(next.plan_code)) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
      "Selected price is not available",
    );
  }
  if (!next.stripe_price_id) throw unavailable();

  const [currentPrice] = live.plan_price_id
    ? await tx<PriceRow[]>`
        SELECT pp.id, p.code AS plan_code, pp.amount_minor::text AS amount_minor,
               cur.code AS currency, pp.billing_interval::text AS billing_interval,
               pp.stripe_price_id
        FROM app.plan_prices pp
        JOIN app.plans p ON p.id = pp.plan_id
        JOIN app.currencies cur ON cur.id = pp.currency_id
        WHERE pp.id = ${live.plan_price_id}::uuid
      `
    : [];

  if (currentPrice?.id === next.id) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.STORAGE_ADDON_ALREADY_ACTIVE,
      "The school is already on this storage tier",
    );
  }
  // A Stripe subscription is billed in one currency for its whole life.
  if (currentPrice && currentPrice.currency !== next.currency) throw unavailable();

  const capBytes = STORAGE_ADDON_TIERS[next.plan_code].capBytes;
  const intervalChanges =
    currentPrice !== undefined && currentPrice.billing_interval !== next.billing_interval;
  const chargeNow = capBytes > Number(live.cap_bytes) || intervalChanges;

  return {
    selected,
    live: { ...live, stripe_subscription_id: live.stripe_subscription_id },
    next: { ...next, plan_code: next.plan_code, stripe_price_id: next.stripe_price_id },
    capBytes,
    chargeNow,
    intervalChanges,
  };
}

function addInterval(from: Date, interval: "monthly" | "yearly"): Date {
  const date = new Date(from);
  if (interval === "yearly") date.setUTCFullYear(date.getUTCFullYear() + 1);
  else date.setUTCMonth(date.getUTCMonth() + 1);
  return date;
}

export interface StorageChangePreview {
  /** Charged the moment the change is confirmed; 0 for a move to less storage. */
  amountDueNowMinor: number;
  /** The next regular bill: the new price, or for a move down, that price less the credit. */
  nextBillMinor: number;
  nextBillAt: Date;
  currency: string;
  chargeNow: boolean;
  price: StorageAddonPrice;
  capBytes: number;
  /** The instant the proration is computed at: send it back with the change. */
  prorationDate: Date;
}

/**
 * What a tier change will cost, from the provider's own preview of the invoice -- nothing is
 * charged or changed. The change itself must quote `prorationDate` and `amountDueNowMinor` back, so
 * the school is charged exactly the amount it was shown.
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

    const preview = await change.selected.port.previewSubscriptionPriceChange!({
      providerSubscriptionId: change.live.stripe_subscription_id,
      priceId: change.next.stripe_price_id,
      chargeNow: change.chargeNow,
      prorationDate: prorationDate.getTime() / 1000,
    });

    const price = toPrice(change.next);
    return {
      amountDueNowMinor: change.chargeNow ? preview.amountDueMinor : 0,
      nextBillMinor: change.chargeNow ? price.amountMinor : preview.amountDueMinor,
      // A new interval restarts the billing period at the change (Stripe resets the cycle anchor).
      nextBillAt: change.intervalChanges
        ? addInterval(prorationDate, change.next.billing_interval)
        : change.live.current_period_end,
      currency: preview.currency,
      chargeNow: change.chargeNow,
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
 * Move the school's live add-on to another tier or interval, prorated by Stripe, for exactly the
 * amount the school confirmed.
 *
 * The preview is recomputed at the confirmed `prorationDate` before anything is charged; if it no
 * longer matches `expectedAmountMinor` (or the preview is too old) the answer is 409
 * STORAGE_ADDON_PRICE_CHANGED and nothing happens. The live row stays locked from that check to the
 * write, so a double click or a second tab waits and then finds the change already made (409
 * STORAGE_ADDON_ALREADY_ACTIVE), and the provider call carries an idempotency key besides.
 *
 * A move to more storage, or to another interval, is invoiced now and applied only when that invoice
 * is paid: a declined card answers 402 and leaves everything as it was. A move to less storage is
 * credited on the next invoice and applies at once -- the school keeps its files even when they no
 * longer fit, and only new uploads wait until it is back under the smaller cap.
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
    const { selected, live, next, capBytes, chargeNow } = change;
    const prorationSeconds = Math.floor(prorationDate.getTime() / 1000);

    const preview = await selected.port.previewSubscriptionPriceChange!({
      providerSubscriptionId: live.stripe_subscription_id,
      priceId: next.stripe_price_id,
      chargeNow,
      prorationDate: prorationSeconds,
    });
    const dueNow = chargeNow ? preview.amountDueMinor : 0;
    if (dueNow !== expectedAmountMinor) throw priceChanged();

    const result = await selected.port.changeSubscriptionPrice!({
      providerSubscriptionId: live.stripe_subscription_id,
      priceId: next.stripe_price_id,
      chargeNow,
      prorationDate: prorationSeconds,
      idempotencyKey: `storage-change:${live.id}:${requestKey}`,
      metadata: { price_id: next.id, billing_interval: next.billing_interval },
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
        charged_now_minor: dueNow,
        currency: preview.currency,
      },
    });

    return {
      planCode: next.plan_code,
      capBytes,
      status: live.status,
      price: toPrice(next),
      currentPeriodEnd: change.intervalChanges
        ? addInterval(prorationDate, next.billing_interval)
        : live.current_period_end,
      cancelAtPeriodEnd: live.cancel_at_period_end,
    };
  });
}

/**
 * Stop the add-on renewing (`cancel: true`) or undo that (`cancel: false`). It stays live, and its
 * cap with it, until the period ends; Stripe's `customer.subscription.deleted` then ends it through
 * the state machine and the school is back on its included storage, files untouched.
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
