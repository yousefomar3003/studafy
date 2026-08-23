import { Button, Modal } from "@studafy/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import type { components } from "@studafy/api-client";

const SESSIONS_QUERY_KEY = ["auth-sessions"];
const DEVICES_QUERY_KEY = ["auth-devices"];

export interface DeviceSessionsPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Lists every live session and registered device for the account (`GET /api/auth/sessions`,
 * `GET /api/auth/devices`) with working revoke actions. Removing a device revokes every session on
 * it and deregisters it in one call (`DELETE /api/auth/devices/{deviceId}`) — including, if it is
 * this device, the session the panel is open from, which signs the caller out. That mirrors what
 * "remove this device" means on any account-security page and is not guarded against here.
 *
 * Both queries are `enabled: open` so opening the user menu never fetches this; the panel's own
 * open/close is what starts and stops the data fetch.
 */
export function DeviceSessionsPanel({ open, onClose }: DeviceSessionsPanelProps) {
  const { t } = useTranslation();
  const { sessionId: currentSessionId } = useAuth();
  const queryClient = useQueryClient();

  const sessionsQuery = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/auth/sessions");
      return data;
    },
    enabled: open,
  });

  const devicesQuery = useQuery({
    queryKey: DEVICES_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/auth/devices");
      return data;
    },
    enabled: open,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
  };

  const revokeSession = useMutation({
    mutationFn: async (sessionId: string) => {
      const { data } = await api.DELETE("/api/auth/sessions/{sessionId}", {
        params: { path: { sessionId } },
      });
      return data;
    },
    onSuccess: invalidate,
  });

  const removeDevice = useMutation({
    mutationFn: async (deviceId: string) => {
      const { data } = await api.DELETE("/api/auth/devices/{deviceId}", {
        params: { path: { deviceId } },
      });
      return data;
    },
    onSuccess: invalidate,
  });

  // `readonly Session[]`/`readonly Device[]` lose their array prototype through the generated
  // response type here — a pre-existing `@studafy/api-client` typing gap, not a shape mismatch.
  // The annotation restores it without widening to `any`.
  const sessions = (sessionsQuery.data?.sessions ??
    []) as readonly components["schemas"]["Session"][];
  const devices = (devicesQuery.data?.devices ?? []) as readonly components["schemas"]["Device"][];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("deviceSessions.title")}
      description={t("deviceSessions.description")}
    >
      <Modal.Body>
        <section aria-labelledby="portal-sessions-heading">
          <h3 id="portal-sessions-heading">{t("deviceSessions.sessionsHeading")}</h3>
          {sessionsQuery.isPending ? (
            <p role="status">{t("deviceSessions.loading")}</p>
          ) : sessions.length === 0 ? (
            <p>{t("deviceSessions.noSessions")}</p>
          ) : (
            <ul className="portal-device-session-list">
              {sessions.map((session) => {
                const isCurrent = session.id === currentSessionId;
                return (
                  <li key={session.id} className="portal-device-session-list__item">
                    <div>
                      <p>{session.device_name ?? session.channel}</p>
                      <p className="portal-device-session-list__meta">
                        {session.ip_address ?? t("deviceSessions.unknownLocation")} &middot;{" "}
                        {new Date(session.issued_at).toLocaleString()}
                      </p>
                    </div>
                    {isCurrent ? (
                      <span className="portal-device-session-list__current">
                        {t("deviceSessions.currentSession")}
                      </span>
                    ) : (
                      <Button
                        variant="tertiary"
                        loading={revokeSession.isPending && revokeSession.variables === session.id}
                        onClick={() => revokeSession.mutate(session.id)}
                      >
                        {t("deviceSessions.revoke")}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="portal-devices-heading">
          <h3 id="portal-devices-heading">{t("deviceSessions.devicesHeading")}</h3>
          {devicesQuery.isPending ? (
            <p role="status">{t("deviceSessions.loading")}</p>
          ) : devices.length === 0 ? (
            <p>{t("deviceSessions.noDevices")}</p>
          ) : (
            <ul className="portal-device-session-list">
              {devices.map((device) => (
                <li key={device.id} className="portal-device-session-list__item">
                  <div>
                    <p>{device.platform}</p>
                    <p className="portal-device-session-list__meta">
                      {t("deviceSessions.activeSessions", { count: device.active_session_count })}
                    </p>
                  </div>
                  <Button
                    variant="tertiary"
                    loading={removeDevice.isPending && removeDevice.variables === device.id}
                    onClick={() => removeDevice.mutate(device.id)}
                  >
                    {t("deviceSessions.removeDevice")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </Modal.Body>
    </Modal>
  );
}
