import { useQuery } from "@tanstack/react-query";

import { DashboardTile } from "../../../components/DashboardTile";
import { api } from "../../../lib/api";
import { useFormatters, useTranslation } from "../../../lib/i18n";

/** No realtime event is routed for user status changes yet, so this polls instead. */
const ACTIVATION_FUNNEL_POLL_MS = 60_000;

/** Invited-to-active user counts, backed by `GET /api/users/status-counts`. */
export function ActivationFunnelTile() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { data, isPending, isError } = useQuery({
    queryKey: ["user-status-counts"],
    queryFn: async () => {
      const { data } = await api.GET("/api/users/status-counts");
      return data;
    },
    refetchInterval: ACTIVATION_FUNNEL_POLL_MS,
  });

  const invited = data?.invited ?? 0;
  const active = data?.active ?? 0;

  return (
    <DashboardTile
      title={t("adminSchool.tiles.activation.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("adminSchool.tiles.activation.error")}
    >
      {invited === 0 && active === 0 ? (
        <p className="dashboard-tile__caption">{t("adminSchool.tiles.activation.empty")}</p>
      ) : (
        <dl className="dashboard-tile__stat-list">
          <div className="dashboard-tile__stat">
            <dt>{t("adminSchool.tiles.activation.invited")}</dt>
            <dd>{formatNumber(invited)}</dd>
          </div>
          <div className="dashboard-tile__stat">
            <dt>{t("adminSchool.tiles.activation.active")}</dt>
            <dd>{formatNumber(active)}</dd>
          </div>
        </dl>
      )}
    </DashboardTile>
  );
}
