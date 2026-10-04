import { DataGrid } from "@studafy/ui";
import { useMemo } from "react";

import { useTranslation } from "../../../../lib/i18n";

import type { AttendanceMatrixRow, AttendanceStatus } from "../types";
import type { DataGridColumn } from "@studafy/ui";

/** Translation keys (not display text) — resolve with `t(...)` at render time. */
export const STATUS_LABEL_KEYS: Record<AttendanceStatus, string> = {
  present: "principal.attendance.status.present",
  absent: "principal.attendance.status.absent",
  late: "principal.attendance.status.late",
  excused: "principal.attendance.status.excused",
};

export function AttendanceStatusBadge({ status }: { status: AttendanceStatus }) {
  const { t } = useTranslation();
  return (
    <span className="attendance-status" data-status={status}>
      {t(STATUS_LABEL_KEYS[status])}
    </span>
  );
}

export interface DailyAttendanceGridProps {
  rows: AttendanceMatrixRow[];
  loading?: boolean;
  onSelectStudent: (row: AttendanceMatrixRow) => void;
}

export function DailyAttendanceGrid({ rows, loading, onSelectStudent }: DailyAttendanceGridProps) {
  const { t } = useTranslation();
  const columns = useMemo<DataGridColumn<AttendanceMatrixRow>[]>(
    () => [
      {
        id: "student",
        header: t("principal.attendance.grid.columns.student"),
        width: "30%",
        renderCell: (row) => (
          <button
            type="button"
            className="attendance-student-link"
            onClick={() => onSelectStudent(row)}
          >
            {row.studentName}
          </button>
        ),
      },
      {
        id: "admission",
        header: t("principal.attendance.grid.columns.admission"),
        renderCell: (row) => row.admissionNumber,
      },
      {
        id: "class",
        header: t("principal.attendance.grid.columns.class"),
        renderCell: (row) => row.classCode,
      },
      {
        id: "section",
        header: t("principal.attendance.grid.columns.section"),
        renderCell: (row) => row.sectionName,
      },
      {
        id: "status",
        header: t("principal.attendance.grid.columns.status"),
        renderCell: (row) => <AttendanceStatusBadge status={row.status} />,
      },
      {
        id: "late",
        header: t("principal.attendance.grid.columns.minutesLate"),
        align: "end",
        renderCell: (row) => row.minutesLate ?? "—",
      },
    ],
    [onSelectStudent, t],
  );
  return (
    <DataGrid
      caption={t("principal.attendance.grid.caption")}
      columns={columns}
      rows={rows}
      getRowId={(row) => row.recordId}
      loading={loading}
      empty={t("principal.attendance.grid.empty")}
      height={440}
      rowHeight={44}
    />
  );
}
