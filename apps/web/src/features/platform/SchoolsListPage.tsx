import { Button, DataGrid, Input, Select } from "@studafy/ui";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { PlatformPageHeader, SchoolStatusPill } from "./PlatformNav";
import { SCHOOLS_PAGE_SIZE, useSchoolsListQuery } from "./queries";

import "./platform.css";

import type { PlatformSchoolStatus, PlatformSchoolSummary } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;
const STATUSES: readonly PlatformSchoolStatus[] = [
  "registered",
  "pending",
  "active",
  "suspended",
  "archived",
];

function parseStatus(value: string | null): PlatformSchoolStatus | "" {
  return STATUSES.find((status) => status === value) ?? "";
}

/**
 * Every school on the platform (`/portal/platform/schools`). `?status=` is read on mount so the
 * overview's breakdown links land here pre-filtered.
 */
export default function SchoolsListPage() {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const [searchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<PlatformSchoolStatus | "">(() =>
    parseStatus(searchParams.get("status")),
  );
  const [page, setPage] = useState(0);

  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // A new filter always starts back at page one.
  useEffect(() => setPage(0), [search, status]);

  const { data, isPending, isError } = useSchoolsListQuery({ search, status, page });
  const total = data?.total ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / SCHOOLS_PAGE_SIZE) - 1);

  const statusOptions: SelectOption<PlatformSchoolStatus | "">[] = [
    { value: "", label: t("platform.schools.allStatuses") },
    ...STATUSES.map((value) => ({ value, label: t(`platform.status.${value}`) })),
  ];

  const columns: DataGridColumn<PlatformSchoolSummary>[] = [
    {
      id: "name",
      header: t("platform.schools.columns.school"),
      renderCell: (school) => (
        <div className="platform-cell-stack">
          <Link to={`/portal/platform/schools/${school.id}`}>{school.name}</Link>
          <span className="platform-muted">{school.slug}</span>
        </div>
      ),
    },
    {
      id: "status",
      header: t("platform.schools.columns.status"),
      renderCell: (school) => <SchoolStatusPill status={school.status} />,
    },
    {
      id: "plan",
      header: t("platform.schools.columns.plan"),
      renderCell: (school) =>
        school.subscription ? (
          <div className="platform-cell-stack">
            <span>{school.subscription.planName}</span>
            <span className="platform-muted">
              {t(`platform.subscriptionStatus.${school.subscription.status}`, {
                defaultValue: school.subscription.status,
              })}
            </span>
          </div>
        ) : (
          <span className="platform-muted">{t("platform.schools.noSubscription")}</span>
        ),
    },
    {
      id: "users",
      header: t("platform.schools.columns.users"),
      renderCell: (school) =>
        t("platform.schools.usersCell", {
          users: formatNumber(school.activeUsers),
          students: formatNumber(school.students),
        }),
    },
    {
      id: "country",
      header: t("platform.schools.columns.country"),
      renderCell: (school) => `${school.countryCode} · ${school.currencyCode}`,
    },
    {
      id: "created",
      header: t("platform.schools.columns.created"),
      renderCell: (school) => formatDate(new Date(school.createdAt), { dateStyle: "medium" }),
    },
  ];

  return (
    <>
      <PlatformPageHeader
        title={t("platform.schools.title")}
        description={t("platform.schools.description")}
      />

      <div className="platform-toolbar">
        <Input
          label={t("platform.schools.searchLabel")}
          placeholder={t("platform.schools.searchPlaceholder")}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          type="search"
        />
        <Select
          label={t("platform.schools.statusFilter")}
          options={statusOptions}
          value={status}
          onChange={(value) => setStatus(value)}
        />
      </div>

      <DataGrid
        caption={t("platform.schools.caption")}
        columns={columns}
        rows={data?.schools ?? []}
        getRowId={(school) => school.id}
        getRowLabel={(school) => school.name}
        loading={isPending}
        empty={isError ? t("platform.schools.loadError") : t("platform.schools.empty")}
      />

      <div className="platform-pagination">
        <span className="platform-muted">
          {t("platform.schools.pageSummary", {
            page: formatNumber(page + 1),
            pages: formatNumber(lastPage + 1),
            total: formatNumber(total),
          })}
        </span>
        <Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>
          {t("platform.common.previous")}
        </Button>
        <Button variant="secondary" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
          {t("platform.common.next")}
        </Button>
      </div>
    </>
  );
}
