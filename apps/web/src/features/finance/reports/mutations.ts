import { useMutation } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { ExportJob, ExportRequest } from "./queries";

/** Queues an async export job (`POST /api/finance/reports/export`) and returns it in its initial
 * `queued` state. `ExportPanel` polls `GET /api/finance/reports/export/{jobId}` from there —
 * mirroring `invoices/mutations.ts`'s `useCreateInvoiceBatch` (create, then poll), not
 * `payments/mutations.ts`'s idempotency-key dance: unlike recording a payment, queuing a duplicate
 * export job is inert (worst case, two identical artifacts), so there is nothing here for an
 * idempotency key to protect against. */
export function useCreateReportExport() {
  return useMutation({
    mutationFn: async (body: ExportRequest): Promise<ExportJob> => {
      const { data } = await api.POST("/api/finance/reports/export", { body });
      if (!data) throw new Error("Couldn't queue the export.");
      return data as ExportJob;
    },
  });
}
