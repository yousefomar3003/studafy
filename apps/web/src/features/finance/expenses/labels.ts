import type { Expense, ExpenseDocumentType } from "./queries";
import type { TFunction } from "i18next";

/** Translation keys (resolved with `t` at render time) for each ERPNext document type. */
export const EXPENSE_DOCUMENT_TYPE_LABEL_KEYS: Record<ExpenseDocumentType, string> = {
  purchase_invoice: "finance.expenses.documentType.purchase_invoice",
  expense_claim: "finance.expenses.documentType.expense_claim",
  journal_entry: "finance.expenses.documentType.journal_entry",
};

/** What "category" refers to for each ERPNext document type — see `createExpenseBodySchema`'s own
 * per-type description in the API's `expenses/schemas.ts`. There is no endpoint that enumerates
 * categories (ERPNext owns their existence, same as `vendor` — see that schema's doc comment), so
 * the entry form takes it as free text; this label just tells the caller which ERPNext doctype the
 * text has to resolve against for the selected document type. */
const CATEGORY_FIELD_LABEL_KEYS: Record<ExpenseDocumentType, string> = {
  purchase_invoice: "finance.expenses.categoryField.purchase_invoice",
  expense_claim: "finance.expenses.categoryField.expense_claim",
  journal_entry: "finance.expenses.categoryField.journal_entry",
};

export function categoryFieldLabel(documentType: ExpenseDocumentType | "", t: TFunction): string {
  if (documentType === "") return t("finance.expenses.categoryField.default");
  // Bounded-key lookup, same shape `expenseStatusLabel` documents below.
  // eslint-disable-next-line security/detect-object-injection
  return t(CATEGORY_FIELD_LABEL_KEYS[documentType]);
}

/** What "vendor" refers to for each ERPNext document type, same source as `CATEGORY_FIELD_LABEL_KEYS`. */
const VENDOR_FIELD_LABEL_KEYS: Record<ExpenseDocumentType, string> = {
  purchase_invoice: "finance.expenses.vendorField.purchase_invoice",
  expense_claim: "finance.expenses.vendorField.expense_claim",
  journal_entry: "finance.expenses.vendorField.journal_entry",
};

export function vendorFieldLabel(documentType: ExpenseDocumentType | "", t: TFunction): string {
  if (documentType === "") return t("finance.expenses.vendorField.default");
  // eslint-disable-next-line security/detect-object-injection
  return t(VENDOR_FIELD_LABEL_KEYS[documentType]);
}

// Same three ERPNext docstatus-derived values `invoices/labels.ts`'s own
// `KNOWN_INVOICE_STATUS_LABEL_KEYS` documents (see `statusFromDocstatus` in the API's
// `expenses/service.ts`) — not a closed enum on the wire, so an unrecognized value falls back to
// itself rather than throwing.
const KNOWN_EXPENSE_STATUS_LABEL_KEYS: Record<string, string> = {
  draft: "finance.docStatus.draft",
  submitted: "finance.docStatus.submitted",
  cancelled: "finance.docStatus.cancelled",
};

export function expenseStatusLabel(status: Expense["erpnext_status"], t: TFunction): string {
  // A lookup into a small fixed local object for display text, not a property/path access driven
  // by untrusted input — same bounded-key shape `invoices/labels.ts`'s `invoiceStatusLabel` documents.
  // eslint-disable-next-line security/detect-object-injection
  const key = KNOWN_EXPENSE_STATUS_LABEL_KEYS[status];
  return key ? t(key) : status;
}

export function expenseStatusTone(
  status: Expense["erpnext_status"],
): "success" | "warning" | "neutral" {
  if (status === "submitted") return "success";
  if (status === "draft") return "warning";
  return "neutral";
}
