import { PAGINATION_MAX_LIMIT } from "@studafy/shared-schemas";
import { Select, Table } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { ExportCsvButton } from "../../components/ExportCsvButton";
import { collectOffsetPages } from "../../lib/data-transfer";
import { useFormatters, useTranslation } from "../../lib/i18n";

import { WHOLE_PERCENT_OPTIONS } from "./format";
import {
  fetchClassAttendanceSummary,
  fetchClassAttendanceSummaryPage,
  lastNDaysRange,
} from "./queries";

import type { ClassAttendanceSummaryItem } from "./queries";
import type { ExportColumn } from "../../lib/data-transfer";
import type { SelectOption } from "@studafy/ui";

import "./school/principal-school.css";

const COLUMN_COUNT = 5;

type RangePreset = "7" | "30" | "90";

const RANGE_PRESETS: readonly RangePreset[] = ["7", "30", "90"];

/**
 * Attendance by class (`/portal/principal/attendance`), drill-through target for the principal
 * dashboard's heat map tile. `?class_id=` (set when a heat map cell is clicked) narrows the table
 * to that one class via the summary endpoint's own `class_id` filter; clearing it goes back to
 * every class.
 */
export default function AttendanceByClassPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const [searchParams] = useSearchParams();
  const classId = searchParams.get("class_id") ?? undefined;
  const [rangeDays, setRangeDays] = useState<RangePreset>("7");

  const range = lastNDaysRange(Number(rangeDays));

  const { data, isPending, isError } = useQuery({
    queryKey: ["attendance-summary", "by-class", range.startDate, range.endDate, classId],
    queryFn: () => fetchClassAttendanceSummary(range, classId),
  });

  const classes = data ?? [];
  const rangeOptions: SelectOption<RangePreset>[] = RANGE_PRESETS.map((value) => ({
    value,
    label: t(`principal.attendanceByClass.range.${value}`),
  }));
  const formatPercent = (value: number) => formatNumber(value / 100, WHOLE_PERCENT_OPTIONS);

  // Percentages go out as the API's raw 0–100 numbers, not locale-formatted strings.
  const exportColumns: ExportColumn<ClassAttendanceSummaryItem>[] = [
    { header: t("principal.attendanceByClass.columns.class"), value: (row) => row.class_code },
    {
      header: t("principal.attendanceByClass.columns.present"),
      value: (row) => row.present_percent,
    },
    {
      header: t("principal.attendanceByClass.columns.absent"),
      value: (row) => row.absent_percent,
    },
    { header: t("principal.attendanceByClass.columns.late"), value: (row) => row.late_percent },
    {
      header: t("principal.attendanceByClass.columns.excused"),
      value: (row) => row.excused_percent,
    },
  ];

  return (
    <>
      <h1>{t("principal.attendanceByClass.title")}</h1>
      <p>{t("principal.attendanceByClass.description")}</p>

      <div className="principal-school__filters">
        <Select
          label={t("principal.attendanceByClass.period")}
          options={rangeOptions}
          value={rangeDays}
          onChange={(value) => setRangeDays(value)}
        />
        <div className="principal-school__actions">
          <ExportCsvButton
            filename="attendance-by-class"
            columns={exportColumns}
            getRows={() =>
              collectOffsetPages((offset) =>
                fetchClassAttendanceSummaryPage(range, classId, offset, PAGINATION_MAX_LIMIT),
              )
            }
          />
        </div>
      </div>

      {classId ? (
        <p>
          {t("principal.attendanceByClass.filtered")}{" "}
          <Link to="/portal/principal/attendance">
            {t("principal.attendanceByClass.clearFilter")}
          </Link>
        </p>
      ) : null}

      <Table caption={t("principal.attendanceByClass.caption")}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("principal.attendanceByClass.columns.class")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.attendanceByClass.columns.present")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.attendanceByClass.columns.absent")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.attendanceByClass.columns.late")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.attendanceByClass.columns.excused")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={isPending}
          empty={
            isError
              ? t("principal.attendanceByClass.error")
              : t("principal.attendanceByClass.empty")
          }
        >
          {classes.map((klass) => (
            <Table.Row key={klass.class_id}>
              <Table.Cell>{klass.class_code}</Table.Cell>
              <Table.Cell>{formatPercent(klass.present_percent)}</Table.Cell>
              <Table.Cell>{formatPercent(klass.absent_percent)}</Table.Cell>
              <Table.Cell>{formatPercent(klass.late_percent)}</Table.Cell>
              <Table.Cell>{formatPercent(klass.excused_percent)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </>
  );
}
