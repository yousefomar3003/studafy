import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { PlatformPageHeader } from "../PlatformNav";

import { useUpdateFeature } from "./mutations";
import { useConsoleFeaturesQuery } from "./queries";

import "../platform.css";
import "./licensing.css";

import type { ConsoleFeature, FeatureStatus } from "./queries";

const STATUSES: readonly FeatureStatus[] = ["active", "paused", "hidden"];

/**
 * Every registered paid feature (`/portal/platform/features`): audience, unit and default limit come
 * from code; the display name and status are the super admin's. Pausing is the kill switch.
 */
export default function FeaturesPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { data: features, isPending, isError } = useConsoleFeaturesQuery();
  const [editing, setEditing] = useState<ConsoleFeature | null>(null);

  return (
    <>
      <PlatformPageHeader
        title={t("platformLicensing.features.title")}
        description={t("platformLicensing.features.description")}
      />
      {isPending ? <p role="status">{t("site.common.loading")}</p> : null}
      {isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
      {features ? (
        <table className="platform-table">
          <caption className="sf-visually-hidden">
            {t("platformLicensing.features.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("platformLicensing.features.columns.feature")}</th>
              <th scope="col">{t("platformLicensing.features.columns.audience")}</th>
              <th scope="col">{t("platformLicensing.features.columns.unit")}</th>
              <th scope="col">{t("platformLicensing.features.columns.defaultLimit")}</th>
              <th scope="col">{t("platformLicensing.features.columns.tiers")}</th>
              <th scope="col">{t("platformLicensing.features.columns.status")}</th>
              <th scope="col">
                <span className="sf-visually-hidden">{t("platformLicensing.common.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {features.map((feature) => (
              <tr key={feature.key}>
                <td>
                  <div className="platform-cell-stack">
                    <span>{feature.displayName}</span>
                    <code className="platform-muted">{feature.key}</code>
                  </div>
                </td>
                <td>{t(`platformLicensing.audience.${feature.audience}`)}</td>
                <td>
                  {feature.unit
                    ? t(`platformLicensing.unit.${feature.unit}`)
                    : t("platformLicensing.features.noUnit")}
                </td>
                <td>
                  {feature.defaultMonthlyLimit === null
                    ? t("platformLicensing.common.unlimited")
                    : formatNumber(feature.defaultMonthlyLimit)}
                </td>
                <td>{formatNumber(feature.tierCount)}</td>
                <td>
                  <span className="platform-pill" data-status={feature.status}>
                    {t(`platformLicensing.featureStatus.${feature.status}`)}
                  </span>
                </td>
                <td>
                  <Button
                    variant="tertiary"
                    onClick={() => setEditing(feature)}
                    aria-label={t("platformLicensing.features.editNamed", {
                      name: feature.displayName,
                    })}
                  >
                    {t("platformLicensing.common.edit")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <EditFeatureModal feature={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function EditFeatureModal({
  feature,
  onClose,
}: {
  feature: ConsoleFeature | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const update = useUpdateFeature();
  const [name, setName] = useState("");
  const [status, setStatus] = useState<FeatureStatus>("active");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // Seed the form once per feature opened, without an effect.
  if (feature && loadedFor !== feature.key) {
    setLoadedFor(feature.key);
    setName(feature.displayName);
    setStatus(feature.status);
  }

  function close() {
    setLoadedFor(null);
    onClose();
  }

  function save() {
    if (!feature || name.trim() === "") return;
    update.mutate(
      { key: feature.key, displayName: name.trim(), status },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("platformLicensing.common.saved") });
          close();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platformLicensing.common.saveError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal
      open={feature !== null}
      onClose={close}
      title={t("platformLicensing.features.editTitle")}
      description={feature?.key}
    >
      <Modal.Body>
        <Input
          label={t("platformLicensing.features.nameLabel")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <Select
          label={t("platformLicensing.features.statusLabel")}
          value={status}
          onChange={setStatus}
          options={STATUSES.map((value) => ({
            value,
            label: t(`platformLicensing.featureStatus.${value}`),
          }))}
          helperText={t(`platformLicensing.features.statusHelp.${status}`)}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={name.trim() === ""}
          loading={update.isPending}
          onClick={save}
        >
          {t("platform.common.save")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
