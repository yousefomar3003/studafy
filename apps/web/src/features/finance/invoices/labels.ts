import type { Invoice, InvoiceBatch, InvoiceBatchItem } from "./queries";
import type { TFunction } from "i18next";

// ---------------------------------------------------------------------------
// Invoice status — the three ERPNext docstatus-derived values `fee-structures/labels.ts`
// documents for a fee structure (`erpNextStatusFromDocstatus`, shared by every synced finance
// entity). Not a closed enum on the wire: an unrecognized value falls back to itself.
// ---------------------------------------------------------------------------

const KNOWN_INVOICE_STATUS_LABEL_KEYS: Record<string, string> = {
  draft: "finance.docStatus.draft",
  submitted: "finance.docStatus.submitted",
  cancelled: "finance.docStatus.cancelled",
  // ERPNext Sales Invoice payment statuses, which synced invoices carry once submitted.
  Paid: "finance.invoiceStatus.Paid",
  Unpaid: "finance.invoiceStatus.Unpaid",
  "Partly Paid": "finance.invoiceStatus.PartlyPaid",
  Overdue: "finance.invoiceStatus.Overdue",
  Return: "finance.invoiceStatus.Return",
  "Credit Note Issued": "finance.invoiceStatus.CreditNoteIssued",
  Cancelled: "finance.invoiceStatus.Cancelled",
  Draft: "finance.invoiceStatus.Draft",
};

export function invoiceStatusLabel(status: Invoice["erpnext_status"], t: TFunction): string {
  // A lookup into a small fixed local object for display text, not a property/path access driven
  // by untrusted input — the same bounded-key shape `fee-structures/labels.ts` documents.
  // eslint-disable-next-line security/detect-object-injection
  const key = KNOWN_INVOICE_STATUS_LABEL_KEYS[status];
  return key ? t(key) : status;
}

export function invoiceStatusTone(
  status: Invoice["erpnext_status"],
): "success" | "warning" | "neutral" {
  if (status === "submitted") return "success";
  if (status === "draft") return "warning";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Batch status
// ---------------------------------------------------------------------------

const BATCH_STATUS_LABEL_KEYS: Record<InvoiceBatch["status"], string> = {
  pending: "finance.invoices.batchStatus.pending",
  processing: "finance.invoices.batchStatus.processing",
  completed: "finance.invoices.batchStatus.completed",
  failed: "finance.invoices.batchStatus.failed",
};

export function invoiceBatchStatusLabel(status: InvoiceBatch["status"], t: TFunction): string {
  // A lookup into a small fixed local object keyed by a closed union type, not a property/path
  // access driven by untrusted input — same bounded-key shape `invoiceStatusLabel` documents above.
  // eslint-disable-next-line security/detect-object-injection
  return t(BATCH_STATUS_LABEL_KEYS[status]);
}

export function invoiceBatchStatusTone(
  status: InvoiceBatch["status"],
): "success" | "warning" | "danger" | "neutral" {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "processing") return "warning";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Batch item status
// ---------------------------------------------------------------------------

const BATCH_ITEM_STATUS_LABEL_KEYS: Record<InvoiceBatchItem["status"], string> = {
  pending: "finance.invoices.batchItemStatus.pending",
  succeeded: "finance.invoices.batchItemStatus.succeeded",
  already_existed: "finance.invoices.batchItemStatus.already_existed",
  failed: "finance.invoices.batchItemStatus.failed",
};

export function invoiceBatchItemStatusLabel(
  status: InvoiceBatchItem["status"],
  t: TFunction,
): string {
  // Same bounded-key shape as `invoiceStatusLabel` above.
  // eslint-disable-next-line security/detect-object-injection
  return t(BATCH_ITEM_STATUS_LABEL_KEYS[status]);
}

export function invoiceBatchItemStatusTone(
  status: InvoiceBatchItem["status"],
): "success" | "warning" | "danger" | "neutral" {
  if (status === "succeeded" || status === "already_existed") return "success";
  if (status === "failed") return "danger";
  if (status === "pending") return "neutral";
  return "neutral";
}
