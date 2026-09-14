import { ApiError } from "@studafy/api-client";
import { Button, Card, useToast } from "@studafy/ui";
import { useState } from "react";

import { useAuth } from "../../../lib/auth";
import { useTranslation } from "../../../lib/i18n";

import { ConfirmDialog } from "./ConfirmDialog";
import { useRemoveDevice, useRevokeOthers, useRevokeSession } from "./mutations";
import { useDevicesQuery, useSessionsQuery } from "./queries";

import "./sessions.css";

import type { components } from "@studafy/api-client";

type Session = components["schemas"]["Session"];
type Device = components["schemas"]["Device"];

type ConfirmState =
  | { kind: "remove-device"; device: Device; sessionCount: number; isCurrent: boolean }
  | { kind: "revoke-others"; otherSessionCount: number; otherDeviceCount: number };

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

/**
 * Account security screen (`/account/sessions`): every live session and registered device for the
 * caller, with the session they're on right now and its device marked, a per-session revoke, a
 * remove-device action, and a "sign out everywhere else" action that keeps this device alive
 * (`POST /api/auth/sessions/revoke-others`, ST-280).
 *
 * Every action that ends more than one session — removing a device (which revokes all of its
 * sessions and deregisters it) and revoking all other sessions — routes through a confirmation
 * dialog, so the irreversible step is always an explicit second click.
 */
export default function SessionsPage() {
  const { t } = useTranslation();
  const { show } = useToast();
  const { sessionId: currentSessionId } = useAuth();

  const sessionsQuery = useSessionsQuery(true);
  const devicesQuery = useDevicesQuery(true);
  const revokeSession = useRevokeSession();
  const removeDevice = useRemoveDevice();
  const revokeOthers = useRevokeOthers();

  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  // `readonly Session[]`/`readonly Device[]` lose their array prototype through the generated
  // response type here — the same pre-existing `@studafy/api-client` typing gap the
  // `DeviceSessionsPanel` documents.
  const sessions = (sessionsQuery.data?.sessions ?? []) as readonly Session[];
  const devices = (devicesQuery.data?.devices ?? []) as readonly Device[];

  const currentSession = sessions.find((session) => session.id === currentSessionId);
  const currentDeviceId = currentSession?.device_id ?? null;

  function openRemoveDevice(device: Device) {
    const sessionCount = sessions.filter((session) => session.device_id === device.id).length;
    setConfirm({
      kind: "remove-device",
      device,
      sessionCount,
      isCurrent: device.id === currentDeviceId,
    });
  }

  function openRevokeOthers() {
    const otherSessionCount = sessions.length - 1;
    const otherDeviceCount = devices.filter((device) => device.id !== currentDeviceId).length;
    setConfirm({ kind: "revoke-others", otherSessionCount, otherDeviceCount });
  }

  function handleConfirmRemoveDevice() {
    if (confirm === null || confirm.kind !== "remove-device") return;
    removeDevice.mutate(confirm.device.id, {
      onSuccess: () => {
        show({ variant: "success", title: t("deviceSessions.removedDeviceToast") });
        setConfirm(null);
      },
      onError: (error) =>
        show({
          variant: "error",
          title: t("deviceSessions.removeDeviceError"),
          description: apiErrorMessage(error, t("deviceSessions.tryAgain")),
        }),
    });
  }

  function handleConfirmRevokeOthers() {
    if (confirm === null || confirm.kind !== "revoke-others") return;
    revokeOthers.mutate(undefined, {
      onSuccess: (result) => {
        show({
          variant: "success",
          title: t("deviceSessions.revokedOthersToast", { count: result?.revoked ?? 0 }),
        });
        setConfirm(null);
      },
      onError: (error) =>
        show({
          variant: "error",
          title: t("deviceSessions.revokeOthersError"),
          description: apiErrorMessage(error, t("deviceSessions.tryAgain")),
        }),
    });
  }

  const showLoadErrors =
    sessionsQuery.isError && devicesQuery.isError && sessions.length === 0 && devices.length === 0;

  return (
    <div className="sessions-page">
      <header className="sessions-page__header">
        <div>
          <h1>{t("deviceSessions.title")}</h1>
          <p>{t("deviceSessions.description")}</p>
        </div>
        {sessions.length > 1 ? (
          <Button type="button" variant="secondary" onClick={openRevokeOthers}>
            {t("deviceSessions.signOutElsewhere")}
          </Button>
        ) : null}
      </header>

      {showLoadErrors ? (
        <p className="sessions-page__notice" role="alert">
          {t("deviceSessions.loadError")}
        </p>
      ) : null}

      <Card as="section" aria-labelledby="sessions-heading">
        <Card.Header>
          <h2 id="sessions-heading">{t("deviceSessions.sessionsHeading")}</h2>
        </Card.Header>
        <Card.Body>
          {sessionsQuery.isPending ? (
            <p role="status">{t("deviceSessions.loading")}</p>
          ) : sessions.length === 0 ? (
            <p>{t("deviceSessions.noSessions")}</p>
          ) : (
            <ul className="sessions-page__list">
              {sessions.map((session) => {
                const isCurrent = session.id === currentSessionId;
                return (
                  <li key={session.id} className="sessions-page__item">
                    <div>
                      <p>{session.device_name ?? session.channel}</p>
                      <p className="sessions-page__meta">
                        {session.ip_address ?? t("deviceSessions.unknownLocation")} &middot;{" "}
                        {new Date(session.issued_at).toLocaleString()}
                      </p>
                    </div>
                    {isCurrent ? (
                      <span className="sessions-page__indicator">
                        {t("deviceSessions.currentSession")}
                      </span>
                    ) : (
                      <Button
                        type="button"
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
        </Card.Body>
      </Card>

      <Card as="section" aria-labelledby="devices-heading">
        <Card.Header>
          <h2 id="devices-heading">{t("deviceSessions.devicesHeading")}</h2>
        </Card.Header>
        <Card.Body>
          {devicesQuery.isPending ? (
            <p role="status">{t("deviceSessions.loading")}</p>
          ) : devices.length === 0 ? (
            <p>{t("deviceSessions.noDevices")}</p>
          ) : (
            <ul className="sessions-page__list">
              {devices.map((device) => {
                const isCurrent = device.id === currentDeviceId;
                return (
                  <li key={device.id} className="sessions-page__item">
                    <div>
                      <p>{device.platform}</p>
                      <p className="sessions-page__meta">
                        {t("deviceSessions.activeSessions", { count: device.active_session_count })}
                      </p>
                    </div>
                    {isCurrent ? (
                      <span className="sessions-page__indicator">
                        {t("deviceSessions.currentDevice")}
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      variant="tertiary"
                      loading={removeDevice.isPending && removeDevice.variables === device.id}
                      onClick={() => openRemoveDevice(device)}
                    >
                      {t("deviceSessions.removeDevice")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card.Body>
      </Card>

      <ConfirmDialog
        open={confirm?.kind === "remove-device"}
        title={t("deviceSessions.confirmRevokeDeviceTitle")}
        body={
          confirm?.kind === "remove-device" && confirm.isCurrent
            ? t("deviceSessions.confirmRevokeCurrentDeviceBody")
            : t("deviceSessions.confirmRevokeDeviceBody", {
                count: confirm?.kind === "remove-device" ? confirm.sessionCount : 0,
              })
        }
        confirmLabel={t("deviceSessions.confirmRevokeDeviceConfirm")}
        loading={removeDevice.isPending}
        onConfirm={handleConfirmRemoveDevice}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm?.kind === "revoke-others"}
        title={t("deviceSessions.confirmRevokeOthersTitle")}
        body={t("deviceSessions.confirmRevokeOthersBody", {
          count: confirm?.kind === "revoke-others" ? confirm.otherSessionCount : 0,
          deviceCount: confirm?.kind === "revoke-others" ? confirm.otherDeviceCount : 0,
        })}
        confirmLabel={t("deviceSessions.confirmRevokeOthersConfirm")}
        loading={revokeOthers.isPending}
        onConfirm={handleConfirmRevokeOthers}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
