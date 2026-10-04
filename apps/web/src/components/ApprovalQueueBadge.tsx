import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { useTranslation } from "../lib/i18n";

/**
 * Pending-approval count badge. Consumes `GET /api/approvals/queue` under the `["approval-queue"]`
 * query key — the exact prefix the realtime client invalidates on approval-relevant events
 * (`src/lib/realtime/invalidations.ts`), so a live `grades.published` fan-out refetches this count
 * with no other wiring. `role="status"` announces count changes to assistive tech.
 *
 * Hides while loading and when the count is zero.
 */
export function ApprovalQueueBadge() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useQuery({
    queryKey: ["approval-queue"],
    queryFn: async () => {
      const { data } = await api.GET("/api/approvals/queue");
      return data;
    },
  });

  if (isPending || isError) {
    return null;
  }

  const total = data?.total ?? 0;
  return (
    <span role="status" className="approval-queue-badge">
      {total > 0 ? t("site.approvalQueueBadge.pending", { count: total }) : ""}
    </span>
  );
}
