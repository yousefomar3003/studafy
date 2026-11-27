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
  const names = (payment.references ?? [])
    .filter((ref) => ref.reference_doctype === "Sales Invoice" && ref.reference_name)
    .map((ref) => ref.reference_name!);
  await refreshInvoices(database, erpnextFactory, schoolId, names, logger, {
    erpnext_docname: payment.name,
    after: "a payment",
  });
}

/**
 * The same for the invoice a credit note was made against: a note that credits its invoice lowers
 * that invoice's outstanding the same silent way (and a note kept on itself leaves it unchanged,
 * which a re-read confirms just as well).
 */
export async function refreshInvoiceCreditedBy(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
  schoolId: string,
  creditNote: { name?: unknown; return_against?: unknown },
  logger: Logger,
): Promise<void> {
  const against = typeof creditNote.return_against === "string" ? creditNote.return_against : "";
  await refreshInvoices(database, erpnextFactory, schoolId, [against], logger, {
    erpnext_docname: creditNote.name,
    after: "a credit note",
  });
}

async function refreshInvoices(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
  schoolId: string,
  docnames: string[],
  logger: Logger,
  context: { erpnext_docname: unknown; after: string },
): Promise<void> {
  const names = [...new Set(docnames.map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0) return;

  try {
    // Driven by an ERPNext webhook, not by the school: not finance activity (erpnext-agent).
    const erpnext = await withTenantTx(database, { schoolId }, (tx) =>
      erpnextFactory.forSchool(tx, schoolId, { recordActivity: false }),
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
      { err, school_id: schoolId, erpnext_docname: context.erpnext_docname, invoices: names },
      `could not refresh invoices after ${context.after}`,
    );
  }
}
