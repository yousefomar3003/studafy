import { Button, DataGrid, Input, Select } from "@studafy/ui";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { APPLICATIONS_PAGE_SIZE, useApplicationsQuery } from "./applications";
import { PlatformPageHeader } from "./PlatformNav";

import "./platform.css";

import type { PlatformApplicationStatus, PlatformApplicationSummary } from "./applications";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;
const STATUSES: readonly PlatformApplicationStatus[] = ["pending", "approved", "rejected"];

/**
 * School sign-up applications (`/portal/platform/applications`): the review queue for the
 * website's "Sign up" flow. Opens on the pending ones; `?status=` deep-links a filter, which is
 * what the onboarding inbox's email links rely on.
 */
export default function ApplicationsPage() {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const [params, setParams] = useSearchParams();
  const statusParam = params.get("status");
  const status: PlatformApplicationStatus | "" = STATUSES.includes(
    statusParam as PlatformApplicationStatus,
  )
    ? (statusParam as PlatformApplicationStatus)
    : statusParam === "all"
      ? ""
      : "pending";
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  useEffect(() => setPage(0), [search, status]);

  const { data, isPending, isError } = useApplicationsQuery({ search, status, page });
  const total = data?.total ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / APPLICATIONS_PAGE_SIZE) - 1);

  const statusOptions: SelectOption<PlatformApplicationStatus | "">[] = [
    { value: "", label: t("platform.applications.allStatuses") },
    ...STATUSES.map((value) => ({ value, label: t(`platform.applications.status.${value}`) })),
  ];

  const columns: DataGridColumn<PlatformApplicationSummary>[] = [
    {
      id: "school",
      header: t("platform.applications.columns.school"),
      renderCell: (application) => (
        <div className="platform-cell-stack">
          <Link to={`/portal/platform/applications/${application.id}`}>
            {application.schoolName}
          </Link>
          <span className="platform-muted">{`${application.city}, ${application.countryName}`}</span>
        </div>
      ),
    },
    {
      id: "applicant",
      header: t("platform.applications.columns.applicant"),
      renderCell: (application) => (
        <div className="platform-cell-stack">
          <span>{application.applicantName}</span>
          <span className="platform-muted">{application.applicantEmail}</span>
        </div>
      ),
    },
    {
      id: "status",
      header: t("platform.applications.columns.status"),
      renderCell: (application) => <ApplicationStatusPill status={application.status} />,
    },
    {
      id: "received",
      header: t("platform.applications.columns.received"),
      renderCell: (application) =>
        formatDate(new Date(application.createdAt), { dateStyle: "medium", timeStyle: "short" }),
    },
  ];

  return (
    <>
      <PlatformPageHeader
        title={t("platform.applications.title")}
        description={t("platform.applications.description")}
      />

      {data && data.pendingCount > 0 ? (
        <p className="platform-muted" role="status">
          {t("platform.applications.pendingCount", { count: data.pendingCount })}
        </p>
      ) : null}

      <div className="platform-toolbar">
        <Input
          label={t("platform.applications.searchLabel")}
          placeholder={t("platform.applications.searchPlaceholder")}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          type="search"
        />
        <Select
          label={t("platform.applications.statusFilter")}
          options={statusOptions}
          value={status}
          onChange={(value) => setParams(value ? { status: value } : { status: "all" })}
        />
      </div>

      <DataGrid
        caption={t("platform.applications.caption")}
        columns={columns}
        rows={data?.applications ?? []}
        getRowId={(application) => application.id}
        getRowLabel={(application) => application.schoolName}
        loading={isPending}
        empty={isError ? t("platform.applications.loadError") : t("platform.applications.empty")}
      />

      <div className="platform-pagination">
        <span className="platform-muted">
          {t("platform.applications.pageSummary", {
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

const STATUS_TONE: Record<PlatformApplicationStatus, "warning" | "success" | "danger"> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
};

export function ApplicationStatusPill({ status }: { status: PlatformApplicationStatus }) {
  const { t } = useTranslation();
  return (
    <span className="platform-pill" data-tone={STATUS_TONE[status]}>
      {t(`platform.applications.status.${status}`)}
    </span>
  );
}
