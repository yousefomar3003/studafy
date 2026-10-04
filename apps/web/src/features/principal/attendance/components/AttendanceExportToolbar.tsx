import { PERMISSIONS } from "@studafy/constants";
import { Button } from "@studafy/ui";

import { usePermissions } from "../../../../lib/auth";
import { useTranslation } from "../../../../lib/i18n";
import { useAttendanceExport } from "../hooks/useAttendanceData";

import type { AttendanceFilters } from "../types";

export function AttendanceExportToolbar({ filters }: { filters: AttendanceFilters }) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const canExport = permissions.has(PERMISSIONS.ATTENDANCE_REPORT_EXPORT);
  const { create, job, isPolling } = useAttendanceExport(filters);
  const busy =
    create.isPending || isPolling || job?.status === "pending" || job?.status === "processing";

  if (!canExport)
    return (
      <span className="attendance-readonly-badge">
        {t("principal.attendance.export.unavailable")}
      </span>
    );
  return (
    <div className="attendance-export" aria-live="polite">
      <Button variant="secondary" loading={busy} onClick={() => create.mutate("xlsx")}>
        {t("principal.attendance.export.xlsx")}
      </Button>
      <Button variant="secondary" loading={busy} onClick={() => create.mutate("pdf")}>
        {t("principal.attendance.export.pdf")}
      </Button>
      {create.isError || job?.status === "failed" ? (
        <span role="alert">{job?.failure_message ?? t("principal.attendance.export.error")}</span>
      ) : null}
      {job?.status === "completed" && job.download_url ? (
        <a href={job.download_url} target="_blank" rel="noreferrer">
          {t("principal.attendance.export.download")}
        </a>
      ) : null}
    </div>
  );
}
