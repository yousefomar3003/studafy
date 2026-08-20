import { useMutation } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { CreateInvoiceBatchBody, InvoiceBatch } from "./queries";

/** Starts a batch generation run. The response's `id` is what `InvoiceBatchPage` then polls via
 * `fetchInvoiceBatch`/`fetchInvoiceBatchItemsPage` for progress — this mutation itself only kicks
 * the run off, it does not wait for it. */
export function useCreateInvoiceBatch() {
  return useMutation({
    mutationFn: async (body: CreateInvoiceBatchBody) => {
      const { data } = await api.POST("/api/finance/invoices/batches", { body });
      if (!data) throw new Error("Invoice batch creation returned no data.");
      return data as InvoiceBatch;
    },
  });
}
