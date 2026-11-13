import { Button, DataGrid, Input, Select } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { PlatformPageHeader } from "../PlatformNav";

import { useActivityQuery, useOperatorsQuery, useSchoolOptionsQuery } from "./queries";

import "../platform.css";
import "./ops.css";

import type { ActivityFilters, PlatformActivityEntry } from "./queries";
import type { DataGridColumn } from "@studafy/ui";

const ACTIONS = [
  "insert",
  "update",
  "delete",
  "login",
  "logout",
  "export",
  "permission_change",
  "read",
] as const;

const EMPTY_FILTERS: ActivityFilters = {
  actorId: "",
  action: "",
  targetTable: "",
  schoolId: "",
  from: "",
  to: "",
};

/** A short, readable summary of what changed: the keys whose value differs, excluding the reason. */
function changedKeys(entry: PlatformActivityEntry): string[] {
  const before = entry.oldValues ?? {};
  const after = entry.newValues ?? {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("reason");
  return [...keys].filter(
    (key) =>
      JSON.stringify((before as Record<string, unknown>)[key]) !==
      JSON.stringify((after as Record<string, unknown>)[key]),
  );
}

/**
 * Studafy staff activity (`/portal/platform/activity`): every change a SUPER_ADMIN or SUPPORT_AGENT
 * made, across all schools, newest first, with the school each one touched and its reason.
 */
export default function ActivityPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const [draft, setDraft] = useState<ActivityFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<ActivityFilters>(EMPTY_FILTERS);
  const operators = useOperatorsQuery();
  const schools = useSchoolOptionsQuery();
  const activity = useActivityQuery(filters);
  const rows = activity.data?.pages.flatMap((page) => page.entries) ?? [];

  const columns: DataGridColumn<PlatformActivityEntry>[] = [
    {
      id: "when",
      header: t("platform.activity.columns.when"),
      renderCell: (entry) =>
        formatDate(new Date(entry.createdAt), { dateStyle: "medium", timeStyle: "short" }),
    },
    {
      id: "who",
      header: t("platform.activity.columns.who"),
      renderCell: (entry) => entry.actor.name ?? entry.actor.email,
    },
    {
      id: "what",
      header: t("platform.activity.columns.what"),
      renderCell: (entry) => {
        const keys = changedKeys(entry);
        return (
          <div className="platform-cell-stack">
            <span>
              {t(`platform.activity.action.${entry.action}`, { defaultValue: entry.action })} ·{" "}
              <code>{entry.targetTable}</code>
            </span>
            {keys.length > 0 ? (
              <span className="platform-muted">{keys.slice(0, 6).join(", ")}</span>
            ) : null}
          </div>
        );
      },
    },
    {
      id: "school",
      header: t("platform.activity.columns.school"),
      renderCell: (entry) =>
        entry.affectedSchool ? (
          <Link to={`/portal/platform/schools/${entry.affectedSchool.id}`}>
            {entry.affectedSchool.name}
          </Link>
        ) : (
          <span className="platform-muted">{t("platform.activity.platformWide")}</span>
        ),
    },
    {
      id: "reason",
      header: t("platform.activity.columns.reason"),
      renderCell: (entry) => entry.reason ?? "—",
    },
  ];

  const operatorOptions = [
    { value: "", label: t("platform.activity.anyone") },
    ...(operators.data ?? []).map((operator) => ({
      value: operator.userId,
      label: operator.name ? `${operator.name} (${operator.email})` : operator.email,
    })),
  ];
  const schoolOptions = [
    { value: "", label: t("platform.activity.anySchool") },
    ...(schools.data ?? []).map((school) => ({ value: school.id, label: school.name })),
  ];
  const actionOptions = [
    { value: "", label: t("platform.activity.anyAction") },
    ...ACTIONS.map((action) => ({ value: action, label: t(`platform.activity.action.${action}`) })),
  ];

  return (
    <>
      <PlatformPageHeader
        title={t("platform.activity.title")}
        description={t("platform.activity.description")}
      />
      <form
        className="platform-ops-filters"
        aria-label={t("platform.activity.filtersLabel")}
        onSubmit={(event) => {
          event.preventDefault();
          setFilters(draft);
        }}
      >
        <Select
          label={t("platform.activity.who")}
          value={draft.actorId}
          onChange={(actorId) => setDraft({ ...draft, actorId })}
          options={operatorOptions}
        />
        <Select
          label={t("platform.activity.actionLabel")}
          value={draft.action}
          onChange={(action) => setDraft({ ...draft, action })}
          options={actionOptions}
        />
        <Input
          label={t("platform.activity.tableLabel")}
          helperText={t("platform.activity.tableHelp")}
          value={draft.targetTable}
          onChange={(event) => setDraft({ ...draft, targetTable: event.target.value })}
        />
        <Select
          label={t("platform.activity.schoolLabel")}
          value={draft.schoolId}
          onChange={(schoolId) => setDraft({ ...draft, schoolId })}
          options={schoolOptions}
        />
        <Input
          label={t("platform.activity.from")}
          type="date"
          value={draft.from}
          onChange={(event) => setDraft({ ...draft, from: event.target.value })}
        />
        <Input
          label={t("platform.activity.to")}
          type="date"
          value={draft.to}
          onChange={(event) => setDraft({ ...draft, to: event.target.value })}
        />
        <div className="platform-ops-filters__actions">
          <Button type="submit" variant="primary">
            {t("platform.activity.apply")}
          </Button>
          <Button
            type="button"
            variant="tertiary"
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              setFilters(EMPTY_FILTERS);
            }}
          >
            {t("platform.activity.clear")}
          </Button>
        </div>
      </form>
      <p className="platform-muted">{t("platform.activity.windowHint")}</p>
      <DataGrid
        caption={t("platform.activity.caption")}
        columns={columns}
        rows={rows}
        getRowId={(entry) => entry.id}
        getRowLabel={(entry) => `${entry.action} ${entry.targetTable}`}
        loading={activity.isPending}
        empty={activity.isError ? t("platform.activity.loadError") : t("platform.activity.empty")}
      />
      {activity.hasNextPage ? (
        <Button
          type="button"
          variant="secondary"
          loading={activity.isFetchingNextPage}
          onClick={() => void activity.fetchNextPage()}
        >
          {t("platform.activity.more")}
        </Button>
      ) : null}
    </>
  );
}
