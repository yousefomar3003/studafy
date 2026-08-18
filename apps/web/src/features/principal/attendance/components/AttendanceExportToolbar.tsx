import { PERMISSIONS } from "@studafy/constants";
import { Button } from "@studafy/ui";

import { usePermissions } from "../../../../lib/auth";
import { useAttendanceExport } from "../hooks/useAttendanceData";

import type { AttendanceFilters } from "../types";

export function AttendanceExportToolbar({ filters }: { filters: AttendanceFilters }) {
  const permissions = usePermissions();
  const canExport = permissions.has(PERMISSIONS.ATTENDANCE_REPORT_EXPORT);
  const { create, job, isPolling } = useAttendanceExport(filters);
  const busy =
    create.isPending || isPolling || job?.status === "pending" || job?.status === "processing";

  if (!canExport) return <span className="attendance-readonly-badge">Export unavailable</span>;
  return (
    <div className="attendance-export" aria-live="polite">
      <Button variant="secondary" loading={busy} onClick={() => create.mutate("xlsx")}>
        Export XLSX
      </Button>
      <Button variant="secondary" loading={busy} onClick={() => create.mutate("pdf")}>
        Export PDF
      </Button>
      {create.isError || job?.status === "failed" ? (
        <span role="alert">{job?.failure_message ?? "Unable to create the export."}</span>
      ) : null}
      {job?.status === "completed" && job.download_url ? (
        <a href={job.download_url} target="_blank" rel="noreferrer">
          Download report
        </a>
      ) : null}
    </div>
  );
}
