import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { requirePaymentProvider } from "../payment-provider-routing";

import type { Database } from "../../../db";
import type { TenantContext } from "../../../db/tenant-tx";
import type { PaymentProviderRegistry } from "../payment-provider-routing";
import type { InvoiceSummary } from "../ports/payment-provider";
import type { BillingProvider } from "@studafy/billing";

export interface ListSchoolInvoicesParams {
  schoolId: string;
  limit?: number;
  startingAfter?: string;
  tenantContext: TenantContext;
}

export interface ListSchoolInvoicesResult {
  invoices: InvoiceSummary[];
  hasMore: boolean;
}

/**
 * List a school's plan-billing invoices. There is no local invoices table (see 000016's header):
 * the provider is the invoice ledger for Studafy's own plan billing, so this reads through to it on
 * every call rather than caching a copy this codebase would then have to keep in sync.
 *
 * Read from whichever provider holds the school's customer: Stripe's invoices, or for a Tap school
 * its charges (Tap issues no invoice object). A school with a customer at both -- one that moved
 * region -- is read from Tap, where its current billing is.
 */
export async function listSchoolInvoices(
  database: Database,
  providers: PaymentProviderRegistry,
  params: ListSchoolInvoicesParams,
): Promise<ListSchoolInvoicesResult> {
  const { schoolId, limit, startingAfter, tenantContext } = params;

  const customer = await withTenantTx(database, tenantContext, async (tx) => {
    const [school] = await tx<
      { stripe_customer_id: string | null; tap_customer_id: string | null }[]
    >`
      SELECT stripe_customer_id, tap_customer_id
      FROM app.schools
      WHERE id = ${schoolId}::uuid
      LIMIT 1
    `;

    if (!school) {
      throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "School not found");
    }

    if (school.tap_customer_id) {
      return { provider: "tap" as BillingProvider, id: school.tap_customer_id };
    }
    return school.stripe_customer_id
      ? { provider: "stripe" as BillingProvider, id: school.stripe_customer_id }
      : null;
  });

  if (!customer) {
    return { invoices: [], hasMore: false };
  }

  const { port } = requirePaymentProvider(providers, customer.provider);
  return port.listInvoices({ customerId: customer.id, limit, startingAfter });
}
