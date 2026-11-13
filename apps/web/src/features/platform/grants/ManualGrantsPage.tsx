import { Select } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { PlatformPageHeader } from "../PlatformNav";

import { GrantsTable } from "./GrantComponents";
import { useAllGrantsQuery } from "./queries";

import "../platform.css";
import "./grants.css";

import type { GrantFilter, GrantKind } from "./queries";
import type { SelectOption } from "@studafy/ui";

/**
 * Every school's manual grants (`/portal/platform/grants`): storage and paid tiers given by hand,
 * filtered to those in force, those ending within 14 days, or those that ended or were revoked.
 */
export default function ManualGrantsPage() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<GrantFilter>("active");
  const [kind, setKind] = useState<GrantKind | "">("");
  const grants = useAllGrantsQuery(filter, kind);

  const filterOptions: SelectOption<GrantFilter>[] = (
    ["active", "expiring", "ended", "all"] as const
  ).map((value) => ({ value, label: t(`platformLicensing.grants.filter.${value}`) }));
  const kindOptions: SelectOption<GrantKind | "all">[] = [
    { value: "all", label: t("platformLicensing.grants.kind.all") },
    { value: "storage", label: t("platformLicensing.grants.kind.storage") },
    { value: "tier", label: t("platformLicensing.grants.kind.tier") },
  ];

  return (
    <>
      <PlatformPageHeader
        title={t("platformLicensing.grants.pageTitle")}
        description={t("platformLicensing.grants.pageDescription")}
      />
      <div className="platform-toolbar">
        <Select
          label={t("platformLicensing.grants.filterLabel")}
          options={filterOptions}
          value={filter}
          onChange={setFilter}
        />
        <Select
          label={t("platformLicensing.grants.kindLabel")}
          options={kindOptions}
          value={kind === "" ? "all" : kind}
          onChange={(value) => setKind(value === "all" ? "" : value)}
        />
      </div>
      <GrantsTable
        grants={grants.data ?? []}
        loading={grants.isPending}
        empty={
          grants.isError
            ? t("platformLicensing.grants.loadError")
            : t("platformLicensing.grants.emptyAll")
        }
        caption={t("platformLicensing.grants.pageTitle")}
        showSchool
      />
    </>
  );
}
