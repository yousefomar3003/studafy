import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";
import type { CursorPage } from "@studafy/ui";

export type Invoice = components["schemas"]["Invoice"];
export type InvoiceDetail = components["schemas"]["InvoiceDetail"];
export type InvoiceLine = components["schemas"]["InvoiceLine"];
export type InvoiceBatch = components["schemas"]["InvoiceBatch"];
export type InvoiceBatchStatus = InvoiceBatch["status"];
export type InvoiceBatchItem = components["schemas"]["InvoiceBatchItem"];
export type InvoiceBatchItemStatus = InvoiceBatchItem["status"];
export type CreateInvoiceBatchBody = components["schemas"]["CreateInvoiceBatchBody"];

const PAGE_SIZE = 20;

export interface InvoiceFilters {
  /** `""` means "every status" — left off the request rather than sent empty. */
  status: string;
  /** Matched server-side against the invoice number first (exact, indexed), then the student's
   * name/admission number — see `listInvoices`'s doc comment in the API's `service.ts`. */
  search: string;
}

/**
 * One page of `GET /api/finance/invoices`, shaped for `@studafy/ui`'s `useCursorPagination` — this
 * list carries no page-local mutation to patch optimistically (unlike `StudentsListPage`, which
 * documents why it uses TanStack Query instead), so the purpose-built hook is the simpler fit.
 */
export async function fetchInvoicesPage(
  filters: InvoiceFilters,
  cursor: string | undefined,
): Promise<CursorPage<Invoice>> {
  const { data } = await api.GET("/api/finance/invoices", {
    params: {
      query: {
        limit: PAGE_SIZE,
        cursor,
        status: (filters.status || undefined) as "draft" | "submitted" | "cancelled" | undefined,
        search: filters.search || undefined,
      },
    },
  });
  // `readonly Invoice[]` loses its array prototype through the generated response type here — the
  // same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx` documents for
  // `notifications`.
  return {
    items: (data?.invoices ?? []) as Invoice[],
    nextCursor: data?.next_cursor ?? undefined,
  };
}

export function invoiceQueryKey(invoiceId: string) {
  return ["finance", "invoices", invoiceId] as const;
}

export async function fetchInvoice(invoiceId: string): Promise<InvoiceDetail> {
  const { data } = await api.GET("/api/finance/invoices/{invoiceId}", {
    params: { path: { invoiceId } },
  });
  if (!data) throw new Error("Invoice not found.");
  return data as InvoiceDetail;
}

// ---------------------------------------------------------------------------
// Batch generation — polled from `InvoiceBatchPage`'s progress panel while the batch is
// pending/processing, same shape as `admin/invitations/BulkInviteProgressPanel`'s poll of a
// bulk-invite batch and its recipients.
// ---------------------------------------------------------------------------

export function invoiceBatchQueryKey(batchId: string) {
  return ["finance", "invoices", "batches", batchId] as const;
}

export async function fetchInvoiceBatch(batchId: string): Promise<InvoiceBatch> {
  const { data } = await api.GET("/api/finance/invoices/batches/{batchId}", {
    params: { path: { batchId } },
  });
  if (!data) throw new Error("Invoice batch not found.");
  return data as InvoiceBatch;
}

const BATCH_ITEMS_PAGE_SIZE = 20;

export async function fetchInvoiceBatchItemsPage(
  batchId: string,
  cursor: string | undefined,
  status: InvoiceBatchItemStatus | "",
): Promise<{ items: InvoiceBatchItem[]; next_cursor: string | null }> {
  const { data } = await api.GET("/api/finance/invoices/batches/{batchId}/items", {
    params: {
      path: { batchId },
      query: {
        limit: BATCH_ITEMS_PAGE_SIZE,
        cursor,
        status: (status || undefined) as InvoiceBatchItemStatus | undefined,
      },
    },
  });
  return {
    items: (data?.items ?? []) as InvoiceBatchItem[],
    next_cursor: data?.next_cursor ?? null,
  };
}
