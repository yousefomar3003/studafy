import { Button, DataGrid, Input } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { PlatformPageHeader, SchoolStatusPill } from "./PlatformNav";
import { useUserLookupQuery } from "./queries";

import "./platform.css";

import type { PlatformUserLookupResult } from "./queries";
import type { DataGridColumn } from "@studafy/ui";
import type { FormEvent } from "react";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Cross-school account lookup (`/portal/platform/users`) — the support desk's "which school is this
 * person in?". Identity is per-school, so one email can match several accounts. Exact email only:
 * the API never offers a substring search across tenants.
 */
export default function UserLookupPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState("");
  const { data, isFetching, isError } = useUserLookupQuery(submitted);
  const valid = EMAIL_PATTERN.test(input.trim());

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (valid) setSubmitted(input.trim());
  }

  const columns: DataGridColumn<PlatformUserLookupResult>[] = [
    {
      id: "school",
      header: t("platform.users.columns.school"),
      renderCell: (match) => (
        <div className="platform-cell-stack">
          <Link to={`/portal/platform/schools/${match.schoolId}`}>{match.schoolName}</Link>
          <SchoolStatusPill status={match.schoolStatus} />
        </div>
      ),
    },
    {
      id: "name",
      header: t("platform.users.columns.name"),
      renderCell: (match) => match.displayName ?? "—",
    },
    {
      id: "roles",
      header: t("platform.users.columns.roles"),
      renderCell: (match) =>
        match.roles.map((role) => t(`platform.roles.${role}`, { defaultValue: role })).join(", ") ||
        "—",
    },
    {
      id: "status",
      header: t("platform.users.columns.status"),
      renderCell: (match) =>
        t(`platform.userStatus.${match.status}`, { defaultValue: match.status }),
    },
    {
      id: "lastLogin",
      header: t("platform.users.columns.lastLogin"),
      renderCell: (match) =>
        match.lastLoginAt
          ? formatDate(new Date(match.lastLoginAt), { dateStyle: "medium", timeStyle: "short" })
          : t("platform.common.never"),
    },
  ];

  return (
    <>
      <PlatformPageHeader
        title={t("platform.users.title")}
        description={t("platform.users.description")}
      />
      <form className="platform-toolbar" onSubmit={onSubmit}>
        <Input
          label={t("platform.users.emailLabel")}
          type="email"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          autoComplete="off"
        />
        <Button type="submit" disabled={!valid} loading={isFetching}>
          {t("platform.users.search")}
        </Button>
      </form>

      {submitted ? (
        <DataGrid
          caption={t("platform.users.caption", { email: submitted })}
          columns={columns}
          rows={data ?? []}
          getRowId={(match) => match.userId}
          getRowLabel={(match) => `${match.email} · ${match.schoolName}`}
          loading={isFetching && !data}
          empty={isError ? t("platform.users.loadError") : t("platform.users.empty")}
        />
      ) : (
        <p className="platform-muted">{t("platform.users.hint")}</p>
      )}
    </>
  );
}
