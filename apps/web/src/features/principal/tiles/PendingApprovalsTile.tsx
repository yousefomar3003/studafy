import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { api } from "../../../lib/api";

/**
 * Reuses the exact `["approval-queue"]` key the sidebar's `ApprovalQueueBadge` and the admin
 * dashboard's own pending-approvals tile use, so this tile gets the same live update a
 * `grades.published` event already triggers for that key — no extra realtime wiring needed here
 * (see `apps/web/src/lib/realtime/invalidations.ts`).
 */
export function PendingApprovalsTile() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["approval-queue"],
    queryFn: async () => {
      const { data } = await api.GET("/api/approvals/queue");
      return data;
    },
  });

  const total = data?.total ?? 0;

  return (
    <DashboardTile
      title="Pending approvals"
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage="Unable to load the approval queue."
    >
      <p className="dashboard-tile__value">{total}</p>
      <p className="dashboard-tile__caption">
        {total === 0 ? "Nothing is waiting on review." : "awaiting review"}
      </p>
      <Link className="dashboard-tile__link" to="/portal/approvals">
        Review approvals →
      </Link>
    </DashboardTile>
  );
}
