import { useMutation } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { auditFilterQuery } from "./queries";

import type { AuditExportJob, AuditLogFilters } from "./queries";

/** `POST /api/audit/logs/export` — queues a CSV export scoped to the filters currently applied to
 * the list. Returns the created job in `queued` status; the caller polls
 * `GET /api/audit/logs/export/{jobId}` (`fetchAuditExportJob`) for its terminal state. */
export function useCreateAuditExport() {
  return useMutation({
    mutationFn: async (filters: AuditLogFilters) => {
      const { data } = await api.POST("/api/audit/logs/export", {
        body: auditFilterQuery(filters),
      });
      if (!data) throw new Error("Audit export creation returned no data.");
      return data as AuditExportJob;
    },
  });
}
