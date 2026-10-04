import { Button, Modal } from "@studafy/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import type { UserWithRoles } from "./queries";
import type { components } from "@studafy/api-client";

/** Matches `Date#toLocaleString()`'s default fields, now formatted in the active locale. */
const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
};

export interface UserSessionsPanelProps {
  user: UserWithRoles | null;
  onClose: () => void;
}

/**
 * Admin view of another user's sessions and devices (ST-187), the counterpart to
 * `layouts/portal/DeviceSessionsPanel.tsx` for the caller's own account. Sessions are read-only here:
 * unlike the self-service `DELETE /api/auth/sessions/{sessionId}`, there is no admin per-session
 * revoke endpoint — only per-device and revoke-all (`admin-device-routes.ts`) — so this panel offers
 * exactly the actions the API actually has, rather than a control for an endpoint that doesn't exist.
 */
export function UserSessionsPanel({ user, onClose }: UserSessionsPanelProps) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const queryClient = useQueryClient();
  const open = user !== null;
  const userId = user?.id;

  const sessionsKey = ["admin-user-sessions", userId];
  const devicesKey = ["admin-user-devices", userId];

  const sessionsQuery = useQuery({
    queryKey: sessionsKey,
    queryFn: async () => {
      const { data } = await api.GET("/api/admin/users/{userId}/sessions", {
        params: { path: { userId: userId! } },
      });
      return data;
    },
    enabled: open,
  });

  const devicesQuery = useQuery({
    queryKey: devicesKey,
    queryFn: async () => {
      const { data } = await api.GET("/api/admin/users/{userId}/devices", {
        params: { path: { userId: userId! } },
      });
      return data;
    },
    enabled: open,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: sessionsKey });
    void queryClient.invalidateQueries({ queryKey: devicesKey });
  };

  const revokeAllDevices = useMutation({
    mutationFn: async () => {
      const { data } = await api.DELETE("/api/admin/users/{userId}/devices", {
        params: { path: { userId: userId! } },
      });
      return data;
    },
    onSuccess: invalidate,
  });

  const revokeDevice = useMutation({
    mutationFn: async (deviceId: string) => {
      const { data } = await api.DELETE("/api/admin/users/{userId}/devices/{deviceId}", {
        params: { path: { userId: userId!, deviceId } },
      });
      return data;
    },
    onSuccess: invalidate,
  });

  // `readonly Session[]`/`readonly Device[]` lose their array prototype through the generated
  // response type here — the same pre-existing `@studafy/api-client` typing gap DeviceSessionsPanel
  // works around, not a shape mismatch.
  const sessions = (sessionsQuery.data?.sessions ??
    []) as readonly components["schemas"]["Session"][];
  const devices = (devicesQuery.data?.devices ?? []) as readonly components["schemas"]["Device"][];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("adminPeople.users.sessions.title")}
      description={user ? `${user.display_name ?? user.email} (${user.email})` : undefined}
    >
      <Modal.Body>
        <section aria-labelledby="admin-sessions-heading">
          <h3 id="admin-sessions-heading">{t("adminPeople.users.sessions.sessionsHeading")}</h3>
          {sessionsQuery.isPending ? (
            <p role="status">{t("adminPeople.common.loading")}</p>
          ) : sessions.length === 0 ? (
            <p>{t("adminPeople.users.sessions.noSessions")}</p>
          ) : (
            <ul className="users-sessions-list">
              {sessions.map((session) => (
                <li key={session.id} className="users-sessions-list__item">
                  <div>
                    <p>
                      {session.device_name ??
                        t(`deviceSessions.channel.${session.channel}`, {
                          defaultValue: session.channel,
                        })}
                    </p>
                    <p className="users-sessions-list__meta">
                      {session.ip_address ?? t("adminPeople.users.sessions.unknownLocation")}{" "}
                      &middot; {formatDate(new Date(session.issued_at), DATE_TIME_OPTIONS)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="admin-devices-heading">
          <div className="users-sessions-list__section-header">
            <h3 id="admin-devices-heading">{t("adminPeople.users.sessions.devicesHeading")}</h3>
            {devices.length > 0 ? (
              <Button
                variant="tertiary"
                loading={revokeAllDevices.isPending}
                onClick={() => revokeAllDevices.mutate()}
              >
                {t("adminPeople.users.sessions.revokeAll")}
              </Button>
            ) : null}
          </div>
          {devicesQuery.isPending ? (
            <p role="status">{t("adminPeople.common.loading")}</p>
          ) : devices.length === 0 ? (
            <p>{t("adminPeople.users.sessions.noDevices")}</p>
          ) : (
            <ul className="users-sessions-list">
              {devices.map((device) => (
                <li key={device.id} className="users-sessions-list__item">
                  <div>
                    <p>{device.platform}</p>
                    <p className="users-sessions-list__meta">
                      {t("adminPeople.users.sessions.activeSessions", {
                        count: device.active_session_count,
                      })}
                    </p>
                  </div>
                  <Button
                    variant="tertiary"
                    loading={revokeDevice.isPending && revokeDevice.variables === device.id}
                    onClick={() => revokeDevice.mutate(device.id)}
                  >
                    {t("adminPeople.users.sessions.revokeDevice")}
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
