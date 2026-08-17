import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Card, DataGrid, Input, Select, useCursorPagination, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { usePermissions } from "../../../lib/auth";

import { ActorFilterField } from "./ActorFilterField";
import { AuditDiffModal } from "./AuditDiffModal";
import { useCreateAuditExport } from "./mutations";
import { auditExportJobQueryKey, fetchAuditExportJob, fetchAuditLogPage } from "./queries";
import { ACTION_LABELS, ACTION_OPTIONS } from "./schema";

import "./audit.css";

import type { AuditExportJob, AuditLogEntry, AuditLogFilters, UserWithRoles } from "./queries";
import type { AuditAction } from "./schema";
import type { DataGridColumn } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;
const EXPORT_POLL_MS = 1500;
const EXPORT_PENDING_STATUSES = new Set<AuditExportJob["status"]>(["queued", "processing"]);

const EXPORT_STATUS_LABELS: Record<AuditExportJob["status"], string> = {
  queued: "Queued",
  processing: "Processing",
  completed: "Ready",
  failed: "Failed",
};

function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.detail ?? error.title) : fallback;
}

/** `target_id`'s full UUID would blow past DataGrid's single-line cell clipping; the shortened form
 * carries the full value in `title` for anyone who needs to copy it. */
function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

function hasSnapshot(entry: AuditLogEntry): boolean {
  return entry.old_values !== null || entry.new_values !== null;
}

/**
 * Audit log explorer (ST-193): filter bar over actor/action/resource/date, a virtualized results
 * grid (`DataGrid` windows its rows internally — see `packages/ui/src/internal/virtual-range.ts`),
 * a before/after diff viewer per entry, and a CSV export flow that polls the queued job to a
 * terminal state.
 *
 * Route-gated on `auditLog:read` rather than `organization:manageSettings` — `FINANCE` and
 * `SUPPORT_AGENT` hold `auditLog:read` without holding org-settings management (see
 * `packages/constants/src/permissions.ts`), and only `auditLog:export` (which `SUPPORT_AGENT` lacks)
 * decides whether the export button renders. Reaching this page today still requires nav access to
 * `/portal/admin` itself, which is gated on `organization:manageSettings` — a pre-existing sidebar
 * limitation (`layouts/portal/nav-items.ts`) this page's own permission gate does not attempt to fix.
 */
export default function AuditLogExplorerPage() {
  const { show } = useToast();
  const permissions = usePermissions();
  const canExport = permissions.has(PERMISSIONS.AUDIT_LOG_EXPORT);

  const [selectedActor, setSelectedActor] = useState<UserWithRoles | null>(null);
  const [action, setAction] = useState<AuditAction | "">("");
  const [targetTableInput, setTargetTableInput] = useState("");
  const [debouncedTargetTable, setDebouncedTargetTable] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedTargetTable(targetTableInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [targetTableInput]);

  const filters: AuditLogFilters = {
    actorId: selectedActor?.id ?? "",
    action,
    targetTable: debouncedTargetTable,
    dateRange: { from: dateFrom || undefined, to: dateTo || undefined },
  };

  const hasActiveFilters =
    filters.actorId !== "" ||
    filters.action !== "" ||
    filters.targetTable !== "" ||
    dateFrom ||
    dateTo;

  function clearFilters() {
    setSelectedActor(null);
    setAction("");
    setTargetTableInput("");
    setDebouncedTargetTable("");
    setDateFrom("");
    setDateTo("");
  }

  // `fetchPage`'s identity is `useCursorPagination`'s reset signal — it must change if and only if
  // a filter value actually changed, so every field the query depends on is listed explicitly.
  const fetchPage = useCallback(
    (cursor: string | undefined) => fetchAuditLogPage(filters, cursor),
    [
      filters.actorId,
      filters.action,
      filters.targetTable,
      filters.dateRange.from,
      filters.dateRange.to,
    ],
  );
  const pagination = useCursorPagination(fetchPage);

  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null);

  // ---------------------------------------------------------------------------
  // CSV export
  // ---------------------------------------------------------------------------

  const createExport = useCreateAuditExport();
  const [exportJob, setExportJob] = useState<AuditExportJob | null>(null);
  const notifiedJobIdRef = useRef<string | null>(null);

  const exportPollQuery = useQuery({
    queryKey: auditExportJobQueryKey(exportJob?.id ?? "none"),
    queryFn: () => fetchAuditExportJob(exportJob?.id as string),
    enabled: exportJob !== null && EXPORT_PENDING_STATUSES.has(exportJob.status),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && EXPORT_PENDING_STATUSES.has(status) ? EXPORT_POLL_MS : false;
    },
  });

  useEffect(() => {
    if (exportPollQuery.data) setExportJob(exportPollQuery.data);
  }, [exportPollQuery.data]);

  useEffect(() => {
    if (!exportJob || notifiedJobIdRef.current === exportJob.id) return;
    if (exportJob.status === "completed") {
      notifiedJobIdRef.current = exportJob.id;
      show({ variant: "success", title: "Audit export ready", description: "Download it below." });
    } else if (exportJob.status === "failed") {
      notifiedJobIdRef.current = exportJob.id;
      show({
        variant: "error",
        title: "Audit export failed",
        description: exportJob.failure_message ?? undefined,
      });
    }
  }, [exportJob, show]);

  function handleExport() {
    createExport.mutate(filters, {
      onSuccess: (job) => {
        setExportJob(job);
        show({
          variant: "info",
          title: "Audit export queued",
          description: "We'll let you know when it's ready.",
        });
      },
      onError: (error) => {
        show({
          variant: "error",
          title: "Couldn't start export",
          description: apiErrorMessage(error, "Please try again."),
        });
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Grid
  // ---------------------------------------------------------------------------

  const columns: DataGridColumn<AuditLogEntry>[] = [
    {
      id: "created_at",
      header: "Timestamp",
      renderCell: (entry) => formatTimestamp(entry.created_at),
      width: 190,
    },
    {
      id: "actor",
      header: "Actor",
      renderCell: (entry) => entry.actor_name ?? entry.actor_email ?? "System",
    },
    {
      id: "action",
      header: "Action",
      renderCell: (entry) => (
        <span className="audit-explorer__action-pill" data-action={entry.action}>
          {ACTION_LABELS[entry.action]}
        </span>
      ),
      width: 160,
    },
    {
      id: "resource",
      header: "Resource",
      renderCell: (entry) => (
        <span title={entry.target_id}>
          {entry.target_table} · {shortId(entry.target_id)}
        </span>
      ),
    },
    {
      id: "client_ip",
      header: "IP address",
      renderCell: (entry) => entry.client_ip ?? "—",
      width: 140,
    },
    {
      id: "diff",
      header: "Diff",
      renderCell: (entry) =>
        hasSnapshot(entry) ? (
          <Button type="button" variant="tertiary" onClick={() => setSelectedEntry(entry)}>
            View diff
          </Button>
        ) : (
          "—"
        ),
      width: 120,
    },
  ];

  return (
    <>
      <div className="audit-explorer__header">
        <div>
          <h1>Audit log</h1>
          <p>Search the school&rsquo;s audit trail by actor, action, resource, and date.</p>
        </div>
        {canExport ? (
          <Button type="button" onClick={handleExport} loading={createExport.isPending}>
            Export CSV
          </Button>
        ) : null}
      </div>

      <div className="audit-explorer__toolbar">
        <ActorFilterField value={selectedActor} onChange={setSelectedActor} />
        <Select
          label="Action"
          options={ACTION_OPTIONS}
          value={action}
          onChange={(value) => setAction(value)}
        />
        <Input
          label="Resource table"
          placeholder="e.g. students, grades, users"
          value={targetTableInput}
          onChange={(event) => setTargetTableInput(event.target.value)}
        />
        <div className="audit-explorer__date-range">
          <Input
            label="From"
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(event) => setDateFrom(event.target.value)}
          />
          <Input
            label="To"
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(event) => setDateTo(event.target.value)}
          />
        </div>
        {hasActiveFilters ? (
          <Button type="button" variant="tertiary" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {exportJob ? (
        <Card as="section" aria-label="Export status">
          <Card.Body>
            <div className="audit-explorer__export-status">
              <span className="audit-explorer__export-status-pill" data-status={exportJob.status}>
                {EXPORT_STATUS_LABELS[exportJob.status]}
              </span>
              {exportJob.status === "completed" && exportJob.download_url ? (
                <a href={exportJob.download_url} target="_blank" rel="noreferrer">
                  Download CSV
                </a>
              ) : null}
              {exportJob.status === "failed" ? (
                <span>{exportJob.failure_message ?? "The export could not be completed."}</span>
              ) : null}
            </div>
          </Card.Body>
        </Card>
      ) : null}

      <DataGrid
        caption="Audit log entries"
        columns={columns}
        rows={pagination.items}
        getRowId={(entry) => entry.id}
        getRowLabel={(entry) => `${ACTION_LABELS[entry.action]} on ${entry.target_table}`}
        loading={pagination.loading}
        empty={
          pagination.error ? "Unable to load the audit log." : "No entries match these filters."
        }
      />

      <div className="audit-explorer__pagination">
        <Button
          type="button"
          variant="secondary"
          disabled={!pagination.hasPreviousPage}
          onClick={pagination.goToPreviousPage}
        >
          Previous
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!pagination.hasNextPage}
          onClick={pagination.goToNextPage}
        >
          Next
        </Button>
      </div>

      <AuditDiffModal entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
    </>
  );
}
