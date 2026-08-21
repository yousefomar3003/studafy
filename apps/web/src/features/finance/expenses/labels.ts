import type { Expense, ExpenseDocumentType } from "./queries";

export const EXPENSE_DOCUMENT_TYPE_LABELS: Record<ExpenseDocumentType, string> = {
  purchase_invoice: "Purchase invoice",
  expense_claim: "Expense claim",
  journal_entry: "Journal entry",
};

/** What "category" refers to for each ERPNext document type — see `createExpenseBodySchema`'s own
 * per-type description in the API's `expenses/schemas.ts`. There is no endpoint that enumerates
 * categories (ERPNext owns their existence, same as `vendor` — see that schema's doc comment), so
 * the entry form takes it as free text; this label just tells the caller which ERPNext doctype the
 * text has to resolve against for the selected document type. */
const CATEGORY_FIELD_LABELS: Record<ExpenseDocumentType, string> = {
  purchase_invoice: "Expense account",
  expense_claim: "Expense type",
  journal_entry: "Account",
};

export function categoryFieldLabel(documentType: ExpenseDocumentType | ""): string {
  if (documentType === "") return "Category";
  // Bounded-key lookup, same shape `expenseStatusLabel` documents below.
  // eslint-disable-next-line security/detect-object-injection
  return CATEGORY_FIELD_LABELS[documentType];
}

/** What "vendor" refers to for each ERPNext document type, same source as `CATEGORY_FIELD_LABELS`. */
const VENDOR_FIELD_LABELS: Record<ExpenseDocumentType, string> = {
  purchase_invoice: "Supplier",
  expense_claim: "Employee",
  journal_entry: "Reference",
};

export function vendorFieldLabel(documentType: ExpenseDocumentType | ""): string {
  if (documentType === "") return "Vendor";
  // eslint-disable-next-line security/detect-object-injection
  return VENDOR_FIELD_LABELS[documentType];
}

// Same three ERPNext docstatus-derived values `invoices/labels.ts`'s own
// `KNOWN_INVOICE_STATUS_LABELS` documents (see `statusFromDocstatus` in the API's
// `expenses/service.ts`) — not a closed enum on the wire, so an unrecognized value falls back to
// itself rather than throwing.
const KNOWN_EXPENSE_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  cancelled: "Cancelled",
};

export function expenseStatusLabel(status: Expense["erpnext_status"]): string {
  // A lookup into a small fixed local object for display text, not a property/path access driven
  // by untrusted input — same bounded-key shape `invoices/labels.ts`'s `invoiceStatusLabel` documents.
  // eslint-disable-next-line security/detect-object-injection
  return KNOWN_EXPENSE_STATUS_LABELS[status] ?? status;
}

export function expenseStatusTone(
  status: Expense["erpnext_status"],
): "success" | "warning" | "neutral" {
  if (status === "submitted") return "success";
  if (status === "draft") return "warning";
  return "neutral";
}
