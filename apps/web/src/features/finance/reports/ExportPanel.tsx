import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Select, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { usePermissions } from "../../../lib/auth";

import { EXPORT_STATUS_LABELS, exportFileFormatLabel, exportStatusTone } from "./labels";
import { useCreateReportExport } from "./mutations";
import { exportJobQueryKey, fetchExportJob } from "./queries";

import type { ExportFileFormat, ExportJob, ExportRequest } from "./queries";
import type { SelectOption } from "@studafy/ui";

const IN_FLIGHT_STATUSES = new Set<ExportJob["status"]>(["queued", "processing"]);
const POLL_INTERVAL_MS = 2000;

const FORMAT_OPTIONS: SelectOption<ExportFileFormat>[] = [
  { value: "csv", label: "CSV" },
  { value: "pdf", label: "PDF" },
];

function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.detail ?? error.title) : fallback;
}

export interface ExportPanelProps {
  /** Used in toast copy and the download link's accessible name, e.g. "Accounts receivable aging". */
  reportLabel: string;
  /** Builds the typed export request for the currently selected format, or `null` when a required
   * filter isn't set yet (e.g. no family picked for a family statement) — `null` disables the
   * export button instead of sending a request the API would reject. Re-evaluated on every render,
   * so it always reflects the panel's current filter state. */
  buildRequest: (fileFormat: ExportFileFormat) => ExportRequest | null;
  /** Shown next to the button while `buildRequest` returns `null`. */
  disabledReason?: string;
}

/**
 * The report center's async download flow: queue a job, poll it, and surface a toast the moment it
 * leaves `queued`/`processing` — the acceptance criterion's "async status with notification on
 * ready." Polling is scoped to this component and stops the moment it unmounts (switching report
 * tabs unmounts the inactive one — see `Tabs.Panel`'s own "always rendered, hidden when inactive"
 * doc comment, which actually unmounts children), the same accepted tradeoff
 * `admin/students/ImportStudentsPage`'s own poll documents for itself. What "long-running reports
 * don't block UI" means here: nothing about this panel blocks the rest of its own report tab (no
 * modal, no full-page spinner) while a job is in flight, and every other tab keeps working
 * independently.
 */
export function ExportPanel({ reportLabel, buildRequest, disabledReason }: ExportPanelProps) {
  const { show } = useToast();
  const permissions = usePermissions();
  const [fileFormat, setFileFormat] = useState<ExportFileFormat>("csv");
  const [jobId, setJobId] = useState<string | null>(null);
  // Which job id has already fired its ready/failed toast — a `useQuery` poll re-delivers the same
  // terminal status on every render until `jobId` changes, so this stops it firing twice.
  const notifiedJobIdRef = useRef<string | null>(null);

  const createExport = useCreateReportExport();

  const jobQuery = useQuery({
    queryKey: exportJobQueryKey(jobId ?? "none"),
    queryFn: () => fetchExportJob(jobId as string),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && IN_FLIGHT_STATUSES.has(status) ? POLL_INTERVAL_MS : false;
    },
  });

  const job = jobQuery.data;

  useEffect(() => {
    if (!job || IN_FLIGHT_STATUSES.has(job.status) || notifiedJobIdRef.current === job.id) return;
    notifiedJobIdRef.current = job.id;
    if (job.status === "completed") {
      show({
        variant: "success",
        title: "Report ready",
        description: `${reportLabel} is ready to download.`,
      });
    } else if (job.status === "failed") {
      show({
        variant: "error",
        title: "Export failed",
        description:
          job.failure_message ?? `${reportLabel} couldn't be generated. Please try again.`,
      });
    }
  }, [job, reportLabel, show]);

  // Export is a write against the report-export gate specifically (`report:export`) — narrower than
  // the `report:viewFinancial` this whole page is already routed behind, so a viewer without the
  // export permission simply doesn't see a download option, matching how `ScholarshipAwardsListPage`
  // hides its own checker-only actions from a maker-only viewer.
  if (!permissions.has(PERMISSIONS.REPORT_EXPORT)) return null;

  const request = buildRequest(fileFormat);
  const inFlight = Boolean(job && IN_FLIGHT_STATUSES.has(job.status));

  function handleExport() {
    if (!request) return;
    notifiedJobIdRef.current = null;
    createExport.mutate(request, {
      onSuccess: (created) => setJobId(created.id),
      onError: (error) => {
        show({
          variant: "error",
          title: "Couldn't queue the export",
          description: apiErrorMessage(error, "Please try again."),
        });
      },
    });
  }

  return (
    <div className="reports-panel__export">
      <Select
        label="Format"
        options={FORMAT_OPTIONS}
        value={fileFormat}
        onChange={setFileFormat}
        disabled={inFlight}
      />
      <Button
        type="button"
        variant="secondary"
        onClick={handleExport}
        loading={createExport.isPending}
        disabled={!request || inFlight}
      >
        Download {exportFileFormatLabel(fileFormat)}
      </Button>

      {!request && disabledReason ? (
        <p className="reports-panel__export-hint">{disabledReason}</p>
      ) : null}

      {job ? (
        <p className="reports-panel__export-status" aria-live="polite">
          <span className="reports-status-pill" data-tone={exportStatusTone(job.status)}>
            {EXPORT_STATUS_LABELS[job.status]}
          </span>
          {job.status === "completed" && job.download_url ? (
            <a href={job.download_url} target="_blank" rel="noreferrer">
              Download {reportLabel}
            </a>
          ) : null}
          {job.status === "failed" ? (
            <Button type="button" variant="tertiary" onClick={() => setJobId(null)}>
              Dismiss
            </Button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
