import { useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { AdminTile } from "../AdminTile";

/**
 * Reuses the exact `["approval-queue"]` key the sidebar's `ApprovalQueueBadge` uses, so this tile
 * gets the same live update a `grades.published` event already triggers for that badge — no extra
 * realtime wiring needed here.
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
    <AdminTile
      title="Pending approvals"
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage="Unable to load the approval queue."
    >
      <p className="admin-tile__value">{total}</p>
      <p className="admin-tile__caption">
        {total === 0 ? "Nothing is waiting on your review." : "awaiting review"}
      </p>
    </AdminTile>
  );
}
