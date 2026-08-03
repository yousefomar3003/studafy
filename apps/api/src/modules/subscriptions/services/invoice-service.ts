import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";

import type { Database } from "../../../db";
import type { TenantContext } from "../../../db/tenant-tx";
import type { InvoiceSummary, PaymentProviderPort } from "../ports/payment-provider";

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
 * List a school's Stripe invoices. There is no local invoices table (see 000016's header): Stripe
 * is the invoice ledger for Studafy's own plan billing, so this reads through to the provider on
 * every call rather than caching a copy this codebase would then have to keep in sync.
 */
export async function listSchoolInvoices(
  database: Database,
  provider: PaymentProviderPort,
  params: ListSchoolInvoicesParams,
): Promise<ListSchoolInvoicesResult> {
  const { schoolId, limit, startingAfter, tenantContext } = params;

  const customerId = await withTenantTx(database, tenantContext, async (tx) => {
    const [school] = await tx<{ stripe_customer_id: string | null }[]>`
      SELECT stripe_customer_id
      FROM app.schools
      WHERE id = ${schoolId}::uuid
      LIMIT 1
    `;

    if (!school) {
      throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "School not found");
    }

    return school.stripe_customer_id;
  });

  if (!customerId) {
    return { invoices: [], hasMore: false };
  }

  return provider.listInvoices({ customerId, limit, startingAfter });
}
