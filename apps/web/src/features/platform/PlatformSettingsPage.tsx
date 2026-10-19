import { ApiError } from "@studafy/api-client";
import { Button, Checkbox, DataGrid, Input, Modal, useToast } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { useUpdatePlatformSetting } from "./mutations";
import { PlatformPageHeader } from "./PlatformNav";
import { usePlatformSettingsQuery } from "./queries";

import "./platform.css";

import type { PlatformSetting } from "./queries";
import type { DataGridColumn } from "@studafy/ui";

/**
 * Platform-wide settings (`/portal/platform/settings`), the `app.platform_settings` table. Only rows
 * seeded as mutable can change here; the rest are shown read-only so operators can see what the
 * platform runs with. Secrets never live in this table (they stay in Secrets Manager).
 */
export default function PlatformSettingsPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { data, isPending, isError } = usePlatformSettingsQuery();
  const [editing, setEditing] = useState<PlatformSetting | null>(null);

  const display = (setting: PlatformSetting) =>
    typeof setting.value === "boolean"
      ? setting.value
        ? t("platform.common.on")
        : t("platform.common.off")
      : String(setting.value);

  const columns: DataGridColumn<PlatformSetting>[] = [
    {
      id: "key",
      header: t("platform.settings.columns.key"),
      renderCell: (setting) => (
        <div className="platform-cell-stack">
          <code>{setting.key}</code>
          <span className="platform-muted">{setting.description}</span>
        </div>
      ),
    },
    {
      id: "value",
      header: t("platform.settings.columns.value"),
      renderCell: (setting) => <code>{display(setting)}</code>,
    },
    {
      id: "flags",
      header: t("platform.settings.columns.notes"),
      renderCell: (setting) =>
        [
          t(`platform.settings.sensitivity.${setting.sensitivity}`),
          setting.requiresRestart ? t("platform.settings.requiresRestart") : null,
        ]
          .filter(Boolean)
          .join(" · "),
    },
    {
      id: "updated",
      header: t("platform.settings.columns.updated"),
      renderCell: (setting) =>
        formatDate(new Date(setting.updatedAt), { dateStyle: "medium", timeStyle: "short" }),
    },
    {
      id: "actions",
      header: t("platform.settings.columns.actions"),
      renderCell: (setting) =>
        setting.isMutable ? (
          <Button variant="tertiary" onClick={() => setEditing(setting)}>
            {t("platform.settings.edit")}
          </Button>
        ) : (
          <span className="platform-muted">{t("platform.settings.locked")}</span>
        ),
    },
  ];

  return (
    <>
      <PlatformPageHeader
        title={t("platform.settings.title")}
        description={t("platform.settings.description")}
      />
      <DataGrid
        caption={t("platform.settings.caption")}
        columns={columns}
        rows={data ?? []}
        getRowId={(setting) => setting.key}
        getRowLabel={(setting) => setting.key}
        loading={isPending}
        empty={isError ? t("platform.settings.loadError") : t("platform.settings.empty")}
      />
      <EditSettingModal setting={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function EditSettingModal({
  setting,
  onClose,
}: {
  setting: PlatformSetting | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const update = useUpdatePlatformSetting();
  const [text, setText] = useState("");
  const [checked, setChecked] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  if (setting && loadedFor !== setting.key) {
    setLoadedFor(setting.key);
    setText(typeof setting.value === "boolean" ? "" : String(setting.value));
    setChecked(setting.value === true);
  }

  const isInteger = setting?.valueType === "integer";
  const integerValid = !isInteger || /^-?\d+$/.test(text.trim());
  const textValid = setting?.valueType !== "text" || text.trim() !== "";

  function close() {
    setLoadedFor(null);
    onClose();
  }

  function save() {
    if (!setting || !integerValid || !textValid) return;
    const value =
      setting.valueType === "boolean"
        ? checked
        : setting.valueType === "integer"
          ? Number.parseInt(text.trim(), 10)
          : text.trim();
    update.mutate(
      { key: setting.key, value },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t("platform.settings.saved"),
            description: setting.requiresRestart ? t("platform.settings.restartNotice") : undefined,
          });
          close();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platform.settings.saveError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal
      open={setting !== null}
      onClose={close}
      title={t("platform.settings.editTitle")}
      description={setting?.key}
    >
      <Modal.Body>
        {setting?.description ? <p>{setting.description}</p> : null}
        {setting?.valueType === "boolean" ? (
          <Checkbox
            label={t("platform.settings.enabled")}
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
        ) : (
          <Input
            label={t("platform.settings.valueLabel")}
            value={text}
            inputMode={isInteger ? "numeric" : undefined}
            error={!integerValid ? t("platform.settings.integerError") : undefined}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!integerValid || !textValid}
          loading={update.isPending}
          onClick={save}
        >
          {t("platform.common.save")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
