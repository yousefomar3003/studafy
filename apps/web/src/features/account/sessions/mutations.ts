import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { DEVICES_QUERY_KEY, SESSIONS_QUERY_KEY } from "./queries";

function invalidateSessionsAndDevices(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
}

/** Terminates one session (`DELETE /api/auth/sessions/{sessionId}`). */
export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const { data } = await api.DELETE("/api/auth/sessions/{sessionId}", {
        params: { path: { sessionId } },
      });
      return data;
    },
    onSuccess: () => invalidateSessionsAndDevices(queryClient),
  });
}

/**
 * Removes one device entirely: every session on it is revoked and the registration is dropped
 * (`DELETE /api/auth/devices/{deviceId}`), so it also stops receiving push notifications.
 */
export function useRemoveDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string) => {
      const { data } = await api.DELETE("/api/auth/devices/{deviceId}", {
        params: { path: { deviceId } },
      });
      return data;
    },
    onSuccess: () => invalidateSessionsAndDevices(queryClient),
  });
}

/**
 * Ends every session the caller holds except the current one (`POST /api/auth/sessions/revoke-others`,
 * ST-280). The current session is identified from the web refresh cookie, so no body is sent.
 */
export function useRevokeOthers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/auth/sessions/revoke-others", { body: undefined });
      return data;
    },
    onSuccess: () => invalidateSessionsAndDevices(queryClient),
  });
}
