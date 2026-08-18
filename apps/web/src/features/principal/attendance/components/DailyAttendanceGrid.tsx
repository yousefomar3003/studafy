import { DataGrid } from "@studafy/ui";
import { useMemo } from "react";

import type { AttendanceMatrixRow, AttendanceStatus } from "../types";
import type { DataGridColumn } from "@studafy/ui";

export const STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: "Present",
  absent: "Absent",
  late: "Tardy",
  excused: "Excused",
};

export function AttendanceStatusBadge({ status }: { status: AttendanceStatus }) {
  const label =
    status === "present"
      ? "Present"
      : status === "absent"
        ? "Absent"
        : status === "late"
          ? "Tardy"
          : "Excused";
  return (
    <span className="attendance-status" data-status={status}>
      {label}
    </span>
  );
}

export interface DailyAttendanceGridProps {
  rows: AttendanceMatrixRow[];
  loading?: boolean;
  onSelectStudent: (row: AttendanceMatrixRow) => void;
}

export function DailyAttendanceGrid({ rows, loading, onSelectStudent }: DailyAttendanceGridProps) {
  const columns = useMemo<DataGridColumn<AttendanceMatrixRow>[]>(
    () => [
      {
        id: "student",
        header: "Student",
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
      { id: "admission", header: "Admission no.", renderCell: (row) => row.admissionNumber },
      { id: "class", header: "Class", renderCell: (row) => row.classCode },
      { id: "section", header: "Section", renderCell: (row) => row.sectionName },
      {
        id: "status",
        header: "Status",
        renderCell: (row) => <AttendanceStatusBadge status={row.status} />,
      },
      {
        id: "late",
        header: "Minutes late",
        align: "end",
        renderCell: (row) => row.minutesLate ?? "—",
      },
    ],
    [onSelectStudent],
  );
  return (
    <DataGrid
      caption="Daily student attendance"
      columns={columns}
      rows={rows}
      getRowId={(row) => row.recordId}
      loading={loading}
      empty="No students match the active filters."
      height={440}
      rowHeight={44}
    />
  );
}
