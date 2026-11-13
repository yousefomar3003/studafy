import { useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";

/**
 * The self-service session/device queries behind both the account sessions screen (`SessionsPage`)
 * and the portal user-menu panel (`layouts/portal/DeviceSessionsPanel`). The query keys are shared
 * by design: a revoke on either surface invalidates the same cache, so one screen never shows a
 * session the other has already ended.
 */
export const SESSIONS_QUERY_KEY = ["auth-sessions"] as const;
export const DEVICES_QUERY_KEY = ["auth-devices"] as const;

export function useSessionsQuery(enabled: boolean) {
  return useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/auth/sessions");
      return data;
    },
    enabled,
  });
}

export function useDevicesQuery(enabled: boolean) {
  return useQuery({
    queryKey: DEVICES_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/auth/devices");
      return data;
    },
    enabled,
  });
}
