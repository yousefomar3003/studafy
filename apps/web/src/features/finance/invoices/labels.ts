import type { Invoice, InvoiceBatch, InvoiceBatchItem } from "./queries";

// ---------------------------------------------------------------------------
// Invoice status — same three ERPNext docstatus-derived values `fee-structures/labels.ts`
// documents for a fee structure (`erpNextStatusFromDocstatus`, shared by every synced finance
// entity). Not a closed enum on the wire: an unrecognized value falls back to itself.
// ---------------------------------------------------------------------------

const KNOWN_INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  cancelled: "Cancelled",
};

export function invoiceStatusLabel(status: Invoice["erpnext_status"]): string {
  // A lookup into a small fixed local object for display text, not a property/path access driven
  // by untrusted input — the same bounded-key shape `fee-structures/labels.ts` documents.
  // eslint-disable-next-line security/detect-object-injection
  return KNOWN_INVOICE_STATUS_LABELS[status] ?? status;
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

const BATCH_STATUS_LABELS: Record<InvoiceBatch["status"], string> = {
  pending: "Queued",
  processing: "Generating…",
  completed: "Completed",
  failed: "Failed",
};

export function invoiceBatchStatusLabel(status: InvoiceBatch["status"]): string {
  // A lookup into a small fixed local object keyed by a closed union type, not a property/path
  // access driven by untrusted input — same bounded-key shape `invoiceStatusLabel` documents above.
  // eslint-disable-next-line security/detect-object-injection
  return BATCH_STATUS_LABELS[status];
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

const BATCH_ITEM_STATUS_LABELS: Record<InvoiceBatchItem["status"], string> = {
  pending: "Pending",
  succeeded: "Created",
  already_existed: "Already existed",
  failed: "Failed",
};

export function invoiceBatchItemStatusLabel(status: InvoiceBatchItem["status"]): string {
  // Same bounded-key shape as `invoiceStatusLabel` above.
  // eslint-disable-next-line security/detect-object-injection
  return BATCH_ITEM_STATUS_LABELS[status];
}

export function invoiceBatchItemStatusTone(
  status: InvoiceBatchItem["status"],
): "success" | "warning" | "danger" | "neutral" {
  if (status === "succeeded" || status === "already_existed") return "success";
  if (status === "failed") return "danger";
  if (status === "pending") return "neutral";
  return "neutral";
}
