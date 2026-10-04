import { Card } from "@studafy/ui";

import { useFormatters, useTranslation } from "../../../../lib/i18n";
import { ONE_DECIMAL_PERCENT_OPTIONS } from "../../format";

import type { AttendanceSummary } from "../types";

export function AttendanceSummaryCards({ summary }: { summary?: AttendanceSummary }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const totals = summary?.totals;
  const items = [
    {
      id: "overall",
      label: t("principal.attendance.summary.overall"),
      value: totals ? formatNumber(totals.present_percent / 100, ONE_DECIMAL_PERCENT_OPTIONS) : "—",
    },
    {
      id: "total-absences",
      label: t("principal.attendance.summary.totalAbsences"),
      value: totals ? formatNumber(totals.absent_count + totals.excused_count) : "—",
    },
    {
      id: "unexcused",
      label: t("principal.attendance.summary.unexcused"),
      value: totals ? formatNumber(totals.absent_count) : "—",
    },
    {
      id: "tardy",
      label: t("principal.attendance.summary.tardy"),
      value: totals ? formatNumber(totals.late_count) : "—",
    },
  ];
  return (
    <div className="attendance-summary" aria-label={t("principal.attendance.summary.label")}>
      {items.map((item) => (
        <Card key={item.id}>
          <p className="attendance-summary__label">{item.label}</p>
          <strong className="attendance-summary__value">{item.value}</strong>
        </Card>
      ))}
    </div>
  );
}
