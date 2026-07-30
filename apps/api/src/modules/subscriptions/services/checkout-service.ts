import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";

import type { Database } from "../../../db";
import type { TenantContext } from "../../../db/tenant-tx";
import type { PaymentProviderPort } from "../ports/payment-provider";

export interface CheckoutParams {
  schoolId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  tenantContext: TenantContext;
}

export interface CheckoutResult {
  url: string;
  sessionId: string;
}

export async function createSchoolCheckoutSession(
  database: Database,
  provider: PaymentProviderPort,
  params: CheckoutParams,
): Promise<CheckoutResult> {
  const { schoolId, priceId, successUrl, cancelUrl, tenantContext } = params;

  return withTenantTx(database, tenantContext, async (tx) => {
    const school = await tx<{ id: string; name: string; stripe_customer_id: string | null }[]>`
      SELECT id, name, stripe_customer_id
      FROM app.schools
      WHERE id = ${schoolId}::uuid
      LIMIT 1
    `;

    if (school.length === 0) {
      throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "School not found");
    }

    const price = await tx<{ stripe_price_id: string | null; plan_id: string }[]>`
      SELECT pp.stripe_price_id, pp.plan_id
      FROM app.plan_prices pp
      WHERE pp.id = ${priceId}::uuid AND pp.is_active = true
      LIMIT 1
    `;

    if (price.length === 0 || !price[0].stripe_price_id) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
        "Selected price is not available or not synced to Stripe",
      );
    }

    let customerId = school[0].stripe_customer_id;

    if (!customerId) {
      const customer = await provider.createCustomer({
        name: school[0].name,
        email: "",
        metadata: { school_id: schoolId },
      });

      customerId = customer.providerCustomerId;

      await tx`
        UPDATE app.schools
        SET stripe_customer_id = ${customerId}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${schoolId}::uuid
      `;
    }

    const session = await provider.createCheckoutSession({
      customerId,
      priceId: price[0].stripe_price_id!,
      successUrl,
      cancelUrl,
      metadata: {
        school_id: schoolId,
        plan_id: price[0].plan_id,
        price_id: priceId,
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
