import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { selectPaymentProviderForSchool } from "../payment-provider-routing";

import type { Database } from "../../../db";
import type { TenantContext } from "../../../db/tenant-tx";
import type { PaymentProviderRegistry, SelectedPaymentProvider } from "../payment-provider-routing";
import type { PaymentProviderPort } from "../ports/payment-provider";
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
    SELECT id, name, stripe_customer_id, tap_customer_id, default_currency_id
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
 * The school's customer at the selected provider, created on first checkout.
 *
 * Written in the same transaction as the rest of checkout. If that transaction rolls back after the
 * provider call, the provider holds a customer Studafy has no record of and the next checkout makes
 * another; for Stripe the `customer.created` webhook repairs the gap, and for Tap the orphan is
 * harmless because attribution also falls back to `metadata.school_id`.
 */
async function ensureProviderCustomer(
  tx: TransactionSql,
  selected: SelectedPaymentProvider,
  school: SchoolBillingRow,
): Promise<string> {
  const existing = selected.name === "tap" ? school.tap_customer_id : school.stripe_customer_id;
  if (existing) return existing;

  const { providerCustomerId } = await selected.port.createCustomer({
    name: school.name,
    email: "",
    metadata: { school_id: school.id },
  });

  // Two literal statements, not an interpolated column name (see the SQL-safety lint).
  if (selected.name === "tap") {
    await tx`
      UPDATE app.schools
      SET tap_customer_id = ${providerCustomerId}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${school.id}::uuid
    `;
  } else {
    await tx`
      UPDATE app.schools
      SET stripe_customer_id = ${providerCustomerId}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${school.id}::uuid
    `;
  }

  return providerCustomerId;
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

    if (!sub || sub.status !== "active") {
      throw new CodedHttpException(
        400,
        ERROR_CODES.AI_SUBSCRIPTION_SCHOOL_NOT_ACTIVE,
        "Cannot purchase AI access: school subscription is not active",
      );
    }

    const [student] = await tx<{ id: string }[]>`
      SELECT id
      FROM app.students
      WHERE id = ${studentId}::uuid AND school_id = ${schoolId}::uuid AND status = 'enrolled'
      LIMIT 1
    `;

    if (!student) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        "Enrolled student not found",
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
