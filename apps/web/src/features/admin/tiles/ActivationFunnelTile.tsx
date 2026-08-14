import { useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { AdminTile } from "../AdminTile";

/** No realtime event is routed for user status changes yet, so this polls instead. */
const ACTIVATION_FUNNEL_POLL_MS = 60_000;

/** Invited-to-active user counts, backed by `GET /api/users/status-counts`. */
export function ActivationFunnelTile() {
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
    <AdminTile
      title="Activation funnel"
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage="Unable to load user activation counts."
    >
      {invited === 0 && active === 0 ? (
        <p className="admin-tile__caption">No invited or active users yet.</p>
      ) : (
        <dl className="admin-tile__stat-list">
          <div className="admin-tile__stat">
            <dt>Invited</dt>
            <dd>{invited}</dd>
          </div>
          <div className="admin-tile__stat">
            <dt>Active</dt>
            <dd>{active}</dd>
          </div>
        </dl>
      )}
    </AdminTile>
  );
}
