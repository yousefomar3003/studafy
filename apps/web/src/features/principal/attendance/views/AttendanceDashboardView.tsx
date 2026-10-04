import { PERMISSIONS } from "@studafy/constants";
import { Button, Card, Checkbox, FilterBar, Select, Table } from "@studafy/ui";
import { useMemo, useState } from "react";

import { usePermissions } from "../../../../lib/auth";
import { useFormatters, useTranslation } from "../../../../lib/i18n";
import { ONE_DECIMAL_PERCENT_OPTIONS } from "../../format";
import { AttendanceExportToolbar } from "../components/AttendanceExportToolbar";
import { AttendanceSummaryCards } from "../components/AttendanceSummaryCards";
import { AttendanceTrendChart } from "../components/AttendanceTrendChart";
import { CorrectionRequestModal } from "../components/CorrectionRequestModal";
import { DailyAttendanceGrid, STATUS_LABEL_KEYS } from "../components/DailyAttendanceGrid";
import { StudentAttendanceHistoryModal } from "../components/StudentAttendanceHistoryModal";
import { BREACH_THRESHOLD, ThresholdBreachList } from "../components/ThresholdBreachList";
import {
  useAttendanceMatrix,
  useAttendanceMetadata,
  useAttendanceSummary,
  useAttendanceTrends,
} from "../hooks/useAttendanceData";
import { useAttendanceFilters } from "../hooks/useAttendanceFilters";

import type {
  AttendanceMatrixRow,
  AttendanceStatus,
  AttendanceTimelineEntry,
  TrendInterval,
} from "../types";
import type { SelectOption } from "@studafy/ui";

import "../attendance.css";

const STATUSES: readonly AttendanceStatus[] = ["present", "absent", "late", "excused"];
const INTERVALS: readonly TrendInterval[] = ["day", "week", "month", "term"];

export default function AttendanceDashboardView() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { filters, updateFilters, clearFilters } = useAttendanceFilters();
  const summary = useAttendanceSummary(filters, filters.view === "class" ? "class" : "student");
  const trends = useAttendanceTrends(filters);
  const matrix = useAttendanceMatrix();
  const metadata = useAttendanceMetadata();
  const permissions = usePermissions();
  const [selected, setSelected] = useState<AttendanceMatrixRow | null>(null);
  const [correction, setCorrection] = useState<AttendanceTimelineEntry | null>(null);
  const [search, setSearch] = useState("");

  const rows = useMemo(
    () =>
      (matrix.data ?? []).filter((row) => {
        const normalizedSearch = search.trim().toLocaleLowerCase();
        if (
          normalizedSearch &&
          !`${row.studentName} ${row.admissionNumber}`
            .toLocaleLowerCase()
            .includes(normalizedSearch)
        )
          return false;
        if (filters.classId && row.classId !== filters.classId) return false;
        if (filters.grade && row.grade !== filters.grade) return false;
        if (filters.sectionId && row.sectionId !== filters.sectionId) return false;
        if (filters.status && row.status !== filters.status) return false;
        if (filters.breachesOnly && row.absentPercent <= BREACH_THRESHOLD) return false;
        return true;
      }),
    [filters, matrix.data, search],
  );

  const statusOptions: SelectOption<AttendanceStatus | "all">[] = [
    { value: "all", label: t("principal.attendance.dashboard.allStatuses") },
    ...STATUSES.map((value) => ({ value, label: t(STATUS_LABEL_KEYS[value]) })),
  ];
  const intervalOptions: SelectOption<TrendInterval>[] = INTERVALS.map((value) => ({
    value,
    label: t(`principal.attendance.interval.${value}`),
  }));
  const formatPercent = (value: number) => formatNumber(value / 100, ONE_DECIMAL_PERCENT_OPTIONS);

  const grades: SelectOption<string>[] = [
    { value: "all", label: t("principal.attendance.dashboard.allGrades") },
    ...(metadata.data?.grades.map((grade) => ({
      value: grade,
      label: t("principal.attendance.dashboard.gradeOption", { grade }),
    })) ?? []),
  ];
  const sections: SelectOption<string>[] = [
    { value: "all", label: t("principal.attendance.dashboard.allSections") },
    ...(metadata.data?.sections
      .filter((section) => !filters.grade || section.grade === filters.grade)
      .map((section) => ({ value: section.id, label: section.name })) ?? []),
  ];
  const chips = [
    filters.grade
      ? {
          id: "grade",
          label: t("principal.attendance.dashboard.gradeOption", { grade: filters.grade }),
        }
      : null,
    filters.sectionId
      ? {
          id: "section",
          label:
            metadata.data?.sections.find((item) => item.id === filters.sectionId)?.name ??
            t("principal.attendance.dashboard.section"),
        }
      : null,
    filters.status
      ? {
          id: "status",
          label:
            statusOptions.find((item) => item.value === filters.status)?.label ?? filters.status,
        }
      : null,
    filters.classId
      ? { id: "class", label: t("principal.attendance.dashboard.classDrillDown") }
      : null,
  ].filter((chip): chip is { id: string; label: string } => chip !== null);

  const removeChip = (id: string) => {
    if (id === "grade") updateFilters({ grade: undefined, sectionId: undefined });
    if (id === "section") updateFilters({ sectionId: undefined });
    if (id === "status") updateFilters({ status: undefined });
    if (id === "class") updateFilters({ classId: undefined });
  };

  return (
    <main className="attendance-dashboard">
      <header className="attendance-header">
        <div>
          <p className="attendance-eyebrow">{t("principal.attendance.dashboard.eyebrow")}</p>
          <h1>{t("principal.attendance.dashboard.title")}</h1>
          <p>{t("principal.attendance.dashboard.description")}</p>
        </div>
        <AttendanceExportToolbar filters={filters} />
      </header>

      <div
        className="attendance-view-toggle"
        aria-label={t("principal.attendance.dashboard.viewToggle")}
      >
        <Button
          variant={filters.view === "school" ? "primary" : "secondary"}
          aria-pressed={filters.view === "school"}
          onClick={() => updateFilters({ view: "school" })}
        >
          {t("principal.attendance.dashboard.schoolView")}
        </Button>
        <Button
          variant={filters.view === "class" ? "primary" : "secondary"}
          aria-pressed={filters.view === "class"}
          onClick={() => updateFilters({ view: "class" })}
        >
          {t("principal.attendance.dashboard.classView")}
        </Button>
      </div>

      <section aria-labelledby="attendance-filters-title">
        <h2 id="attendance-filters-title" className="attendance-visually-hidden">
          {t("principal.attendance.dashboard.filtersTitle")}
        </h2>
        <FilterBar
          searchLabel={t("principal.attendance.dashboard.searchLabel")}
          searchPlaceholder={t("principal.attendance.dashboard.searchPlaceholder")}
          search={search}
          onSearchChange={setSearch}
          dateRange={{ from: filters.startDate, to: filters.endDate }}
          onDateRangeChange={(range) =>
            updateFilters({
              startDate: range.from ?? filters.startDate,
              endDate: range.to ?? filters.endDate,
              termId: undefined,
            })
          }
          chips={chips}
          onRemoveChip={removeChip}
          onClearAll={chips.length > 0 || filters.breachesOnly ? clearFilters : undefined}
        />
        <div className="attendance-facets">
          <Select
            label={t("principal.attendance.dashboard.grade")}
            options={grades}
            value={filters.grade ?? "all"}
            onChange={(value) =>
              updateFilters({ grade: value === "all" ? undefined : value, sectionId: undefined })
            }
          />
          <Select
            label={t("principal.attendance.dashboard.section")}
            options={sections}
            value={filters.sectionId ?? "all"}
            onChange={(value) => updateFilters({ sectionId: value === "all" ? undefined : value })}
          />
          <Select
            label={t("principal.attendance.dashboard.statusLabel")}
            options={statusOptions}
            value={filters.status ?? "all"}
            onChange={(value) => updateFilters({ status: value === "all" ? undefined : value })}
          />
          <Select
            label={t("principal.attendance.dashboard.intervalLabel")}
            options={intervalOptions}
            value={filters.interval}
            onChange={(interval) => updateFilters({ interval })}
          />
          <Checkbox
            label={t("principal.attendance.dashboard.breachesOnly")}
            checked={filters.breachesOnly}
            onChange={(event) => updateFilters({ breachesOnly: event.target.checked })}
          />
        </div>
      </section>

      {summary.isError ? (
        <p className="attendance-error" role="alert">
          {t("principal.attendance.dashboard.summaryError")}
        </p>
      ) : null}
      <AttendanceSummaryCards summary={summary.data} />

      {filters.view === "class" && summary.data ? (
        <Card>
          <h2>{t("principal.attendance.dashboard.classBreakdown")}</h2>
          <Table caption={t("principal.attendance.dashboard.classCaption")}>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>
                  {t("principal.attendance.dashboard.classColumns.class")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("principal.attendance.dashboard.classColumns.present")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("principal.attendance.dashboard.classColumns.absent")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("principal.attendance.dashboard.classColumns.tardy")}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body columnCount={4} empty={t("principal.attendance.dashboard.classEmpty")}>
              {summary.data.items
                .filter((item) => item.group_by === "class")
                .map((item) => (
                  <Table.Row key={item.class_id}>
                    <Table.Cell>{item.class_code}</Table.Cell>
                    <Table.Cell>{formatPercent(item.present_percent)}</Table.Cell>
                    <Table.Cell>{formatPercent(item.absent_percent)}</Table.Cell>
                    <Table.Cell>{formatPercent(item.late_percent)}</Table.Cell>
                  </Table.Row>
                ))}
            </Table.Body>
          </Table>
        </Card>
      ) : null}

      <div className="attendance-analytics-grid">
        <AttendanceTrendChart data={trends.data} loading={trends.isPending} />
        <ThresholdBreachList rows={rows} onSelectStudent={setSelected} />
      </div>

      <section aria-labelledby="daily-attendance-title">
        <div className="attendance-section-heading">
          <div>
            <h2 id="daily-attendance-title">{t("principal.attendance.dashboard.dailyTitle")}</h2>
            <p>
              {t("principal.attendance.dashboard.studentCount", {
                count: rows.length,
                formatted: formatNumber(rows.length),
              })}
            </p>
          </div>
          {matrix.isFetching ? (
            <span role="status">{t("principal.attendance.dashboard.refreshing")}</span>
          ) : null}
        </div>
        <DailyAttendanceGrid rows={rows} loading={matrix.isPending} onSelectStudent={setSelected} />
      </section>

      <StudentAttendanceHistoryModal
        studentId={correction ? null : (selected?.studentId ?? null)}
        recordId={selected?.recordId ?? null}
        onClose={() => setSelected(null)}
        onRequestCorrection={setCorrection}
      />
      <CorrectionRequestModal
        entry={correction}
        canOverride={permissions.has(PERMISSIONS.ATTENDANCE_CORRECTION_OVERRIDE)}
        onClose={() => setCorrection(null)}
        onSubmitted={() => {
          setCorrection(null);
          setSelected(null);
        }}
      />
    </main>
  );
}
