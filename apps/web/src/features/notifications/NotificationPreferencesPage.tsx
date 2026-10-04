import { ApiError } from "@studafy/api-client";
import { NOTIFICATION_TYPES } from "@studafy/constants";
import { NOTIFICATION_CHANNELS } from "@studafy/notification-templates";
import { Button, Card, Chip, Input, Table, useToast } from "@studafy/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";

import { notificationChannelLabel, notificationTypeLabel } from "./labels";
import { useUpdatePreferences } from "./mutations";
import { usePreferencesQuery } from "./queries";

import "./notifications.css";

import type { NotificationPreferenceUpdate } from "./mutations";
import type { NotificationPreference } from "./queries";
import type { FormEvent } from "react";

const ORDERED_TYPES = Object.values(NOTIFICATION_TYPES);
const ORDERED_CHANNELS = Object.values(NOTIFICATION_CHANNELS);

interface PendingPatch {
  enabled?: boolean;
  digest?: boolean;
}

function cellKey(type: string, channel: string): string {
  return `${type}:${channel}`;
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

/**
 * Notification preferences (`/portal/notifications/preferences`). No permission gate, mirroring
 * `notificationPreferencesRoutes`'s doc comment — RLS scopes every row to the caller regardless of
 * role, so every session manages only its own preferences.
 *
 * Per-(type, channel) toggles are staged locally and batched into one `PATCH` on save, matching the
 * request schema's own `preferences: [...]` array shape rather than firing one request per checkbox.
 * A mandatory type (only `ADMIN_ANNOUNCEMENT` today — see `MANDATORY_NOTIFICATION_TYPES`) renders
 * every channel checkbox checked and disabled, so it reads as locked rather than merely pre-checked.
 * The attendance-alert threshold saves independently, the same "each setting persists on its own"
 * posture `admin/settings/SettingsCard` documents for the school settings screen.
 */
export default function NotificationPreferencesPage() {
  const { t } = useTranslation();
  const { show } = useToast();
  const preferencesQuery = usePreferencesQuery();
  // Two independent mutation instances, not one shared between the two forms below: they save
  // independently (see the doc comment above), so their `isPending` states must not cross-talk —
  // saving the threshold must not also flash the channel table's own save button into a loading
  // state, and vice versa.
  const updatePreferences = useUpdatePreferences();
  const updateThreshold = useUpdatePreferences();

  const [pending, setPending] = useState<Map<string, PendingPatch>>(new Map());
  const [threshold, setThreshold] = useState("");
  const thresholdHydrated = useRef(false);

  useEffect(() => {
    if (!thresholdHydrated.current && preferencesQuery.data) {
      const current = preferencesQuery.data.attendance_alert_threshold;
      setThreshold(current === null ? "" : String(current));
      thresholdHydrated.current = true;
    }
  }, [preferencesQuery.data]);

  const cells = useMemo(() => {
    const map = new Map<string, NotificationPreference>();
    // A bare list loses its `Array` prototype through the generated response type — the same
    // pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx` documents.
    const preferences = (preferencesQuery.data?.preferences ??
      []) as readonly NotificationPreference[];
    for (const pref of preferences) {
      map.set(cellKey(pref.notification_type, pref.channel), pref);
    }
    return map;
  }, [preferencesQuery.data]);

  function effectiveEnabled(pref: NotificationPreference): boolean {
    return pending.get(cellKey(pref.notification_type, pref.channel))?.enabled ?? pref.enabled;
  }

  function effectiveDigest(pref: NotificationPreference): boolean {
    return pending.get(cellKey(pref.notification_type, pref.channel))?.digest ?? pref.digest;
  }

  function setPatch(type: string, channel: string, patch: PendingPatch) {
    setPending((current) => {
      const next = new Map(current);
      const key = cellKey(type, channel);
      next.set(key, { ...next.get(key), ...patch });
      return next;
    });
  }

  function handleSavePreferences() {
    const preferences: NotificationPreferenceUpdate[] = [...pending.entries()].map(
      ([key, patch]) => {
        const [notification_type, channel] = key.split(":");
        return { notification_type, channel, ...patch } as NotificationPreferenceUpdate;
      },
    );
    if (preferences.length === 0) return;

    updatePreferences.mutate(
      { preferences },
      {
        onSuccess: () => {
          setPending(new Map());
          show({ variant: "success", title: t("site.notifications.preferences.savedToast") });
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("site.notifications.preferences.saveError"),
            description: apiErrorMessage(error, t("site.common.tryAgain")),
          }),
      },
    );
  }

  function handleSaveThreshold(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = threshold.trim() === "" ? null : Number(threshold);

    updateThreshold.mutate(
      { attendance_alert_threshold: value },
      {
        onSuccess: () =>
          show({
            variant: "success",
            title: t("site.notifications.preferences.thresholdSavedToast"),
          }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("site.notifications.preferences.thresholdSaveError"),
            description: apiErrorMessage(error, t("site.common.tryAgain")),
          }),
      },
    );
  }

  return (
    <>
      <div className="notifications-page__header">
        <div>
          <h1>{t("site.notifications.preferences.title")}</h1>
          <p>{t("site.notifications.preferences.description")}</p>
        </div>
        <Link to="/portal/notifications">
          <Button type="button" variant="secondary">
            {t("site.notifications.preferences.backToInbox")}
          </Button>
        </Link>
      </div>

      {preferencesQuery.isError ? (
        <p className="notifications-page__notice" role="alert">
          {t("site.notifications.preferences.loadError")}
        </p>
      ) : null}

      {preferencesQuery.isPending ? (
        <p role="status">{t("site.common.loading")}</p>
      ) : (
        <>
          <Card as="section" aria-label={t("site.notifications.preferences.channelsLabel")}>
            <Card.Header>
              <h2>{t("site.notifications.preferences.channelsHeading")}</h2>
              <p className="notifications-page__card-description">
                {t("site.notifications.preferences.channelsDescription")}
              </p>
            </Card.Header>
            <Card.Body>
              <div className="notifications-prefs">
                <Table caption={t("site.notifications.preferences.tableCaption")}>
                  <Table.Header>
                    <Table.Row>
                      <Table.HeaderCell>
                        {t("site.notifications.preferences.typeColumn")}
                      </Table.HeaderCell>
                      {ORDERED_CHANNELS.map((channel) => (
                        <Table.HeaderCell key={channel}>
                          {notificationChannelLabel(channel, t)}
                        </Table.HeaderCell>
                      ))}
                      <Table.HeaderCell>
                        {t("site.notifications.preferences.digestColumn")}
                      </Table.HeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body columnCount={ORDERED_CHANNELS.length + 2}>
                    {ORDERED_TYPES.map((type) => {
                      const emailCell = cells.get(cellKey(type, NOTIFICATION_CHANNELS.EMAIL));
                      const mandatory = emailCell?.mandatory ?? false;
                      const digestEligible = emailCell?.digest_eligible ?? false;
                      const typeLabel = notificationTypeLabel(type, t);

                      return (
                        <Table.Row key={type}>
                          <Table.Cell>
                            <span className="notifications-prefs__type">
                              {typeLabel}
                              {mandatory ? (
                                <Chip variant="outlined">
                                  {t("site.notifications.preferences.mandatory")}
                                </Chip>
                              ) : null}
                            </span>
                          </Table.Cell>
                          {ORDERED_CHANNELS.map((channel) => {
                            const pref = cells.get(cellKey(type, channel));
                            return (
                              <Table.Cell key={channel}>
                                {pref ? (
                                  <input
                                    type="checkbox"
                                    className="notifications-prefs__checkbox"
                                    checked={effectiveEnabled(pref)}
                                    disabled={pref.mandatory}
                                    aria-label={t("site.notifications.preferences.cellLabel", {
                                      type: typeLabel,
                                      channel: notificationChannelLabel(channel, t),
                                    })}
                                    onChange={(event) =>
                                      setPatch(type, channel, { enabled: event.target.checked })
                                    }
                                  />
                                ) : null}
                              </Table.Cell>
                            );
                          })}
                          <Table.Cell>
                            {emailCell ? (
                              <input
                                type="checkbox"
                                className="notifications-prefs__checkbox"
                                checked={effectiveDigest(emailCell)}
                                disabled={!digestEligible}
                                aria-label={t("site.notifications.preferences.digestCellLabel", {
                                  type: typeLabel,
                                })}
                                onChange={(event) =>
                                  setPatch(type, NOTIFICATION_CHANNELS.EMAIL, {
                                    digest: event.target.checked,
                                  })
                                }
                              />
                            ) : null}
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table>
              </div>
            </Card.Body>
            <Card.Footer>
              <Button
                type="button"
                disabled={pending.size === 0}
                loading={updatePreferences.isPending}
                onClick={handleSavePreferences}
              >
                {t("site.notifications.preferences.saveChannels")}
              </Button>
            </Card.Footer>
          </Card>

          <Card as="section" aria-label={t("site.notifications.preferences.thresholdLabel")}>
            <Card.Header>
              <h2>{t("site.notifications.preferences.attendanceHeading")}</h2>
              <p className="notifications-page__card-description">
                {t("site.notifications.preferences.attendanceDescription")}
              </p>
            </Card.Header>
            <form
              onSubmit={handleSaveThreshold}
              noValidate
              aria-label={t("site.notifications.preferences.thresholdLabel")}
            >
              <Card.Body>
                <Input
                  label={t("site.notifications.preferences.thresholdInput")}
                  type="number"
                  min={1}
                  max={365}
                  value={threshold}
                  onChange={(event) => setThreshold(event.target.value)}
                  helperText={t("site.notifications.preferences.thresholdHelper")}
                />
              </Card.Body>
              <Card.Footer>
                <Button type="submit" loading={updateThreshold.isPending}>
                  {t("site.notifications.preferences.saveThreshold")}
                </Button>
              </Card.Footer>
            </form>
          </Card>
        </>
      )}
    </>
  );
}
