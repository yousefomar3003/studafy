import { createHash } from "node:crypto";

import { LIVE_STATUSES } from "@studafy/billing";
import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { studentSchoolSeat } from "../../licensing/seat-coverage";
import { selectPaymentProviderForSchool } from "../payment-provider-routing";

import {
  findLiveStorageAddon,
  findStoragePrice,
  requireOnlineStorageProvider,
} from "./storage-addon-service";

import type { Database } from "../../../db";
import type { TenantContext } from "../../../db/tenant-tx";
import type { PaymentProviderRegistry, SelectedPaymentProvider } from "../payment-provider-routing";
import type { PaymentProviderPort } from "../ports/payment-provider";
import type { SubscriptionStatus } from "@studafy/constants";
import type { TransactionSql } from "postgres";

export interface CheckoutParams {
  schoolId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  tenantContext: TenantContext;
}

export interface TieredCheckoutParams {
  schoolId: string;
  planId: string;
  successUrl: string;
  cancelUrl: string;
  tenantContext: TenantContext;
}

export interface CheckoutResult {
  url: string;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

interface SchoolBillingRow {
  id: string;
  name: string;
  stripe_customer_id: string | null;
  /** Mode of `stripe_customer_id`: true live, false Sandbox, null not yet known (000225). */
  stripe_customer_livemode: boolean | null;
  tap_customer_id: string | null;
  default_currency_id: string;
}

/** An `app.plan_prices` row with what either provider needs to charge it. */
interface PlanPriceRow {
  id: string;
  plan_id: string;
  stripe_price_id: string | null;
  /** bigint, read as text so postgres.js does not hand back a string pretending to be a number. */
  amount_minor: string;
  currency: string;
  billing_interval: "monthly" | "yearly";
}

async function findSchool(tx: TransactionSql, schoolId: string): Promise<SchoolBillingRow> {
  const [school] = await tx<SchoolBillingRow[]>`
    SELECT id, name, stripe_customer_id, stripe_customer_livemode, tap_customer_id,
           default_currency_id
    FROM app.schools
    WHERE id = ${schoolId}::uuid
    LIMIT 1
  `;

  if (!school) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "School not found");
  }
  return school;
}

/**
 * The school's customer at the selected provider, created on first checkout -- exactly one per
 * school, and for Stripe one per account mode (live or Sandbox, docs/billing/stripe-modes.md).
 *
 * The id is written in the same transaction as the rest of checkout, so a checkout that fails after
 * this call rolls the write back. That used to leave an orphan at Stripe and make a new customer on
 * every retry (seven "studafy test school" customers by 2026-11-14). Now nothing is lost: before
 * creating one, the customer Stripe already holds for the school (`metadata.school_id`) is reused,
 * and the create carries an idempotency key per school and mode, so a retry inside Stripe's window
 * gets the same customer back even while search has not caught up.
 *
 * A stored Stripe id is used only when it belongs to the key's mode. One from the other mode (after
 * switching between live and Sandbox keys) is replaced by this mode's customer; its mode is asked of
 * Stripe once when not yet recorded.
 */
async function ensureProviderCustomer(
  tx: TransactionSql,
  selected: SelectedPaymentProvider,
  school: SchoolBillingRow,
): Promise<string> {
  if (selected.name === "tap") {
    if (school.tap_customer_id) return school.tap_customer_id;
    const { providerCustomerId } = await selected.port.createCustomer({
      name: school.name,
      email: "",
      metadata: { school_id: school.id },
    });
    await tx`
      UPDATE app.schools
      SET tap_customer_id = ${providerCustomerId}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${school.id}::uuid
    `;
    return providerCustomerId;
  }

  const port = selected.port;
  const livemode = port.livemode;

  // A test double or a key of unknown mode: the stored customer is used as it is.
  if (livemode === undefined) {
    if (school.stripe_customer_id) return school.stripe_customer_id;
  } else if (school.stripe_customer_id) {
    if (school.stripe_customer_livemode === livemode) return school.stripe_customer_id;
    if (school.stripe_customer_livemode === null && port.retrieveCustomer) {
      const seen = await port.retrieveCustomer(school.stripe_customer_id);
      if (seen && seen.livemode === livemode) {
        await storeStripeCustomer(tx, school.id, school.stripe_customer_id, livemode);
        return school.stripe_customer_id;
      }
    }
    // From the other mode (or gone): this mode's customer takes its place below.
  }

  const reused = port.findCustomerBySchoolId ? await port.findCustomerBySchoolId(school.id) : null;
  const customerId =
    reused ??
    (
      await port.createCustomer({
        name: school.name,
        email: "",
        metadata: { school_id: school.id },
        idempotencyKey: customerIdempotencyKey(school, livemode),
      })
    ).providerCustomerId;

  await storeStripeCustomer(tx, school.id, customerId, livemode ?? null);
  return customerId;
}

/** One key per school, mode and name: the create's parameters must match for Stripe to replay it. */
function customerIdempotencyKey(school: SchoolBillingRow, livemode: boolean | undefined): string {
  const mode = livemode === undefined ? "unknown" : livemode ? "live" : "sandbox";
  const name = createHash("sha256").update(school.name).digest("hex").slice(0, 16);
  return `school-customer:${school.id}:${mode}:${name}`;
}

async function storeStripeCustomer(
  tx: TransactionSql,
  schoolId: string,
  customerId: string,
  livemode: boolean | null,
): Promise<void> {
  await tx`
    UPDATE app.schools
    SET stripe_customer_id = ${customerId}, stripe_customer_livemode = ${livemode},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${schoolId}::uuid
  `;
}

/**
 * The price as the selected provider charges it.
 *
 * Stripe charges a catalog price, so the row must have been synced. Tap has no catalog and charges
 * the amount itself, so the local price id is passed only for reference.
 */
function checkoutLine(
  selected: SelectedPaymentProvider,
  price: PlanPriceRow,
): { priceId: string; amountMinor: number; currency: string } {
  const amount = { amountMinor: Number(price.amount_minor), currency: price.currency };

  if (selected.name === "tap") return { priceId: price.id, ...amount };

  if (!price.stripe_price_id) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
      "Selected price is not available or not synced to Stripe",
    );
  }
  return { priceId: price.stripe_price_id, ...amount };
}

/**
 * What a later renewal needs to charge the same price again, carried on the checkout's metadata.
 *
 * Stripe renews on its own and ignores these. For Tap, Studafy renews: the renewal worker reads
 * `price_id` (and `seat_billing`) back off the subscription's last paid charge, and the Tap
 * normalizer reads `billing_interval` to date the first period.
 */
function renewalMetadata(price: PlanPriceRow): { price_id: string; billing_interval: string } {
  return { price_id: price.id, billing_interval: price.billing_interval };
}

async function findActivePriceById(
  tx: TransactionSql,
  priceId: string,
): Promise<PlanPriceRow | undefined> {
  const [price] = await tx<PlanPriceRow[]>`
    SELECT pp.id, pp.plan_id, pp.stripe_price_id, pp.amount_minor::text AS amount_minor,
           cur.code AS currency, pp.billing_interval::text AS billing_interval
    FROM app.plan_prices pp
    JOIN app.currencies cur ON cur.id = pp.currency_id
    WHERE pp.id = ${priceId}::uuid AND pp.is_active = true
    LIMIT 1
  `;
  return price;
}

// ---------------------------------------------------------------------------
// Checkout flows
// ---------------------------------------------------------------------------

export async function createSchoolCheckoutSession(
  database: Database,
  providers: PaymentProviderRegistry,
  params: CheckoutParams,
): Promise<CheckoutResult> {
  const { schoolId, priceId, successUrl, cancelUrl, tenantContext } = params;

  return withTenantTx(database, tenantContext, async (tx) => {
    const school = await findSchool(tx, schoolId);
    const selected = await selectPaymentProviderForSchool(tx, providers, schoolId);

    const price = await findActivePriceById(tx, priceId);
    if (!price) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
        "Selected price is not available",
      );
    }

    const line = checkoutLine(selected, price);
    const customerId = await ensureProviderCustomer(tx, selected, school);

    const session = await selected.port.createCheckoutSession({
      customerId,
      ...line,
      successUrl,
      cancelUrl,
      metadata: {
        school_id: schoolId,
        plan_id: price.plan_id,
        ...renewalMetadata(price),
      },
    });

    return { url: session.url, sessionId: session.sessionId };
  });
}

export async function createBillingPortalSession(
  database: Database,
  provider: PaymentProviderPort,
  schoolId: string,
  returnUrl: string,
  tenantContext: TenantContext,
): Promise<{ url: string }> {
  return withTenantTx(database, tenantContext, async (tx) => {
    const school = await tx<{ stripe_customer_id: string | null }[]>`
      SELECT stripe_customer_id
      FROM app.schools
      WHERE id = ${schoolId}::uuid
      LIMIT 1
    `;

    if (school.length === 0) {
      throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "School not found");
    }

    if (!school[0].stripe_customer_id) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
        "School has no Stripe customer yet. Complete a checkout first.",
      );
    }

    return provider.createBillingPortalSession({
      customerId: school[0].stripe_customer_id,
      returnUrl,
    });
  });
}

export async function createTieredSchoolCheckoutSession(
  database: Database,
  providers: PaymentProviderRegistry,
  params: TieredCheckoutParams,
): Promise<CheckoutResult> {
  const { schoolId, planId, successUrl, cancelUrl, tenantContext } = params;

  return withTenantTx(database, tenantContext, async (tx) => {
    const school = await findSchool(tx, schoolId);
    const selected = await selectPaymentProviderForSchool(tx, providers, schoolId);

    const plan = await tx<{ id: string }[]>`
      SELECT id FROM app.plans
      WHERE id = ${planId}::uuid AND is_active = true
      LIMIT 1
    `;

    if (plan.length === 0) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
        "Selected plan is not available",
      );
    }

    // For Stripe only a synced price is chargeable; Tap charges any active price directly.
    const requireStripePrice = selected.name === "stripe";
    const [price] = await tx<PlanPriceRow[]>`
      SELECT pp.id, pp.plan_id, pp.stripe_price_id, pp.amount_minor::text AS amount_minor,
             cur.code AS currency, pp.billing_interval::text AS billing_interval
      FROM app.plan_prices pp
      JOIN app.currencies cur ON cur.id = pp.currency_id
      WHERE pp.plan_id = ${planId}::uuid
        AND pp.currency_id = ${school.default_currency_id}::uuid
        AND pp.is_active = true
        AND (NOT ${requireStripePrice}::boolean OR pp.stripe_price_id IS NOT NULL)
      ORDER BY pp.billing_interval
      LIMIT 1
    `;

    if (!price) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
        "No active price found for this plan in the school's currency",
      );
    }

    const [{ count }] = await tx<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM app.students
      WHERE school_id = ${schoolId}::uuid AND status = 'enrolled'
    `;

    const seatCount = Number(count);

    if (seatCount === 0) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
        "School has no enrolled students to subscribe for",
      );
    }

    const line = checkoutLine(selected, price);
    const customerId = await ensureProviderCustomer(tx, selected, school);

    const session = await selected.port.createCheckoutSession({
      customerId,
      ...line,
      quantity: seatCount,
      successUrl,
      cancelUrl,
      metadata: {
        school_id: schoolId,
        plan_id: planId,
        ...renewalMetadata(price),
        seat_billing: "enrolled_students",
      },
    });

    return { url: session.url, sessionId: session.sessionId };
  });
}

export interface AiCheckoutParams {
  schoolId: string;
  priceId: string;
  studentId: string;
  successUrl: string;
  cancelUrl: string;
  tenantContext: TenantContext;
}

export async function createAiCheckoutSession(
  database: Database,
  providers: PaymentProviderRegistry,
  params: AiCheckoutParams,
): Promise<CheckoutResult> {
  const { schoolId, priceId, studentId, successUrl, cancelUrl, tenantContext } = params;

  return withTenantTx(database, tenantContext, async (tx) => {
    const school = await findSchool(tx, schoolId);

    const [sub] = await tx<{ status: string }[]>`
      SELECT status::text AS status
      FROM app.subscriptions
      WHERE school_id = ${schoolId}::uuid
      LIMIT 1
    `;

    // The same "school is live" rule the AI entitlement gate applies (LIVE_STATUSES): a school in
    // grace or past due keeps its students' AI, so it does not stop them buying it either.
    if (!sub || !LIVE_STATUSES.has(sub.status as SubscriptionStatus)) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.AI_SUBSCRIPTION_SCHOOL_NOT_ACTIVE,
        "Cannot purchase AI access: school subscription is not active",
      );
    }

    // Bought by the student themselves or by a parent linked to them -- the same students
    // GET /api/subscriptions/ai/offer lists (ai-offer-service.ts). Anyone else gets the same 404 as
    // a student that does not exist: who is enrolled is not the caller's business.
    const [student] = await tx<{ id: string }[]>`
      SELECT s.id
      FROM app.students s
      WHERE s.id = ${studentId}::uuid
        AND s.school_id = ${schoolId}::uuid
        AND s.status = 'enrolled'
        AND (
          s.user_id = ${tenantContext.userId ?? null}::uuid
          OR EXISTS (
            SELECT 1 FROM app.parent_child_links l
            WHERE l.school_id = s.school_id
              AND l.student_id = s.id
              AND l.parent_user_id = ${tenantContext.userId ?? null}::uuid
          )
        )
      LIMIT 1
    `;

    if (!student) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        "Enrolled student not found",
      );
    }

    // A student holding a school seat -- on the license in force, or a Student AI programme seat
    // waiting for its licence to start -- is provided for by the school and is never sold a
    // personal purchase (docs/billing/feature-licensing.md, session 6; owner, 2026-11-18). The
    // offer hides the button; this keeps a stale page or a direct call from buying anyway.
    const seat = await studentSchoolSeat(tx, schoolId, studentId);
    if (seat) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.AI_SUBSCRIPTION_COVERED_BY_SCHOOL,
        "This student's school provides AI access through a license seat",
      );
    }

    const selected = await selectPaymentProviderForSchool(tx, providers, schoolId);

    const price = await findActivePriceById(tx, priceId);
    if (!price) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
        "Selected price is not available",
      );
    }

    const line = checkoutLine(selected, price);
    const customerId = await ensureProviderCustomer(tx, selected, school);

    const session = await selected.port.createCheckoutSession({
      customerId,
      ...line,
      successUrl,
      cancelUrl,
      metadata: {
        school_id: schoolId,
        student_id: studentId,
        ...renewalMetadata(price),
      },
    });

    return { url: session.url, sessionId: session.sessionId };
  });
}

function storagePurchasePending(): CodedHttpException {
  return new CodedHttpException(
    409,
    ERROR_CODES.STORAGE_ADDON_PURCHASE_PENDING,
    "A storage purchase for this school is already paid or being confirmed",
  );
}

/**
 * Refuse while the provider already has a live storage subscription for the customer, and close
 * every storage checkout still open so only the one about to be made can be paid. A checkout paid
 * while it was being closed counts as a live purchase.
 */
async function closeEarlierStorageCheckouts(
  selected: SelectedPaymentProvider,
  customerId: string,
): Promise<void> {
  const { findAddonPurchasesInFlight, expireCheckoutSession } = selected.port;
  if (!findAddonPurchasesInFlight || !expireCheckoutSession) {
    // Selling storage online requires both (requireOnlineStorageProvider admits Stripe only).
    throw new CodedHttpException(
      409,
      ERROR_CODES.STORAGE_ADDON_UNAVAILABLE,
      "The storage add-on cannot be bought online for this school",
    );
  }

  const inFlight = await findAddonPurchasesInFlight.call(selected.port, {
    customerId,
    addon: "storage",
  });
  if (inFlight.liveSubscriptionIds.length > 0) throw storagePurchasePending();

  for (const sessionId of inFlight.openCheckoutSessionIds) {
    if ((await expireCheckoutSession.call(selected.port, sessionId)) === "completed") {
      throw storagePurchasePending();
    }
  }
}

export interface StorageCheckoutParams {
  schoolId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  tenantContext: TenantContext;
}

/**
 * A checkout for the school's storage add-on (db/migrations/000205).
 *
 * `addon: "storage"` on the metadata is what the webhook pipeline attributes it by: without it the
 * purchase would fall through to the school's own subscription. One add-on per school -- a school
 * that has one changes its tier (storage-addon-service.ts) rather than buying a second, which would
 * bill it twice.
 *
 * Studafy's own row appears only when the provider's webhook arrives, which can be a minute after
 * the payment. So a second purchase is also refused while the provider itself holds a live storage
 * subscription for the school, and every earlier checkout still open is closed before a new one is
 * made: at most one payable storage checkout exists for a school at any moment.
 */
export async function createStorageCheckoutSession(
  database: Database,
  providers: PaymentProviderRegistry,
  params: StorageCheckoutParams,
): Promise<CheckoutResult> {
  const { schoolId, priceId, successUrl, cancelUrl, tenantContext } = params;

  return withTenantTx(database, tenantContext, async (tx) => {
    // One storage checkout at a time per school: a double click, a second tab or a retry waits here
    // for the first to finish, then sees what it did.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`storage-checkout:${schoolId}`}, 0))`;

    const school = await findSchool(tx, schoolId);
    const selected = await requireOnlineStorageProvider(tx, providers, schoolId);

    const storagePrice = await findStoragePrice(tx, priceId);
    const price = storagePrice ? await findActivePriceById(tx, storagePrice.id) : undefined;
    if (!price) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
        "Selected price is not available",
      );
    }

    if (await findLiveStorageAddon(tx, schoolId)) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.STORAGE_ADDON_ALREADY_ACTIVE,
        "The school already has a storage add-on; change its tier instead",
      );
    }

    const line = checkoutLine(selected, price);
    const customerId = await ensureProviderCustomer(tx, selected, school);

    await closeEarlierStorageCheckouts(selected, customerId);

    const session = await selected.port.createCheckoutSession({
      customerId,
      ...line,
      successUrl,
      cancelUrl,
      metadata: {
        school_id: schoolId,
        plan_id: price.plan_id,
        addon: "storage",
        ...renewalMetadata(price),
      },
    });

    return { url: session.url, sessionId: session.sessionId };
  });
}
