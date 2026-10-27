import { withTenantTx } from "../../../db/tenant-tx";

import { projectInvoiceEntry } from "./projection";

import type { ErpNextSalesInvoice } from "./projection";
import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { TenantErpNextFactory } from "../client/tenant-client";
import type { ErpNextPaymentEntry } from "../payments/projection";

/**
 * Re-read from ERPNext every Sales Invoice a submitted Payment Entry settles, and re-project it.
 *
 * ERPNext lowers an invoice's outstanding amount when a payment against it is submitted, but it
 * does so with a direct column write that fires no document event, so no Sales Invoice webhook
 * follows. Without this, `invoice_cache` would keep showing a paid invoice as owed: the family
 * views, the reminders and the family payment split all read it. Best-effort: a failure is logged
 * and the next payment or reconciliation corrects the row.
 */
export async function refreshInvoicesSettledBy(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
  schoolId: string,
  payment: ErpNextPaymentEntry,
  logger: Logger,
): Promise<void> {
  const names = [
    ...new Set(
      (payment.references ?? [])
        .filter((ref) => ref.reference_doctype === "Sales Invoice" && ref.reference_name)
        .map((ref) => ref.reference_name!.trim()),
    ),
  ];
  if (names.length === 0) return;

  try {
    const erpnext = await withTenantTx(database, { schoolId }, (tx) =>
      erpnextFactory.forSchool(tx, schoolId),
    );
    for (const name of names) {
      const response = await erpnext.get<{ data: ErpNextSalesInvoice }>(
        `/api/resource/Sales%20Invoice/${encodeURIComponent(name)}`,
      );
      await withTenantTx(database, { schoolId }, (tx) =>
        projectInvoiceEntry(tx, schoolId, response.data.data, logger),
      );
    }
  } catch (err) {
    logger.warn(
      { err, school_id: schoolId, erpnext_docname: payment.name, invoices: names },
      "could not refresh invoices after a payment",
    );
  }
}
