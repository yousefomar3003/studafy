import { Card } from "@studafy/ui";

import type { AttendanceSummary } from "../types";

export function AttendanceSummaryCards({ summary }: { summary?: AttendanceSummary }) {
  const totals = summary?.totals;
  const items = [
    { label: "Overall attendance", value: totals ? `${totals.present_percent.toFixed(1)}%` : "—" },
    {
      label: "Total absences",
      value: totals ? String(totals.absent_count + totals.excused_count) : "—",
    },
    { label: "Unexcused absences", value: totals ? String(totals.absent_count) : "—" },
    { label: "Tardy", value: totals ? String(totals.late_count) : "—" },
  ];
  return (
    <div className="attendance-summary" aria-label="Attendance summary">
      {items.map((item) => (
        <Card key={item.label}>
          <p className="attendance-summary__label">{item.label}</p>
          <strong className="attendance-summary__value">{item.value}</strong>
        </Card>
      ))}
    </div>
  );
}
