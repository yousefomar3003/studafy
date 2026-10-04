import { useQuery } from "@tanstack/react-query";

import { DashboardTile } from "../../../components/DashboardTile";
import { api } from "../../../lib/api";
import { useFormatters, useTranslation } from "../../../lib/i18n";

/**
 * Reuses the exact `["approval-queue"]` key the sidebar's `ApprovalQueueBadge` uses, so this tile
 * gets the same live update a `grades.published` event already triggers for that badge — no extra
 * realtime wiring needed here.
 */
export function PendingApprovalsTile() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
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
      title={t("adminSchool.tiles.approvals.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("adminSchool.tiles.approvals.error")}
    >
      <p className="dashboard-tile__value">{formatNumber(total)}</p>
      <p className="dashboard-tile__caption">
        {total === 0
          ? t("adminSchool.tiles.approvals.empty")
          : t("adminSchool.tiles.approvals.awaiting")}
      </p>
    </DashboardTile>
  );
}
