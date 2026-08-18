import { PERMISSIONS } from "@studafy/constants";
import { Button, Card, Checkbox, FilterBar, Select, Table } from "@studafy/ui";
import { useMemo, useState } from "react";

import { usePermissions } from "../../../../lib/auth";
import { AttendanceExportToolbar } from "../components/AttendanceExportToolbar";
import { AttendanceSummaryCards } from "../components/AttendanceSummaryCards";
import { AttendanceTrendChart } from "../components/AttendanceTrendChart";
import { CorrectionRequestModal } from "../components/CorrectionRequestModal";
import { DailyAttendanceGrid } from "../components/DailyAttendanceGrid";
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

const STATUS_OPTIONS: SelectOption<AttendanceStatus | "all">[] = [
  { value: "all", label: "All statuses" },
  { value: "present", label: "Present" },
  { value: "absent", label: "Absent" },
  { value: "late", label: "Tardy" },
  { value: "excused", label: "Excused" },
];
const INTERVAL_OPTIONS: SelectOption<TrendInterval>[] = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "term", label: "Term overview" },
];

export default function AttendanceDashboardView() {
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

  const grades: SelectOption<string>[] = [
    { value: "all", label: "All grades" },
    ...(metadata.data?.grades.map((grade) => ({ value: grade, label: `Grade ${grade}` })) ?? []),
  ];
  const sections: SelectOption<string>[] = [
    { value: "all", label: "All sections" },
    ...(metadata.data?.sections
      .filter((section) => !filters.grade || section.grade === filters.grade)
      .map((section) => ({ value: section.id, label: section.name })) ?? []),
  ];
  const chips = [
    filters.grade ? { id: "grade", label: `Grade ${filters.grade}` } : null,
    filters.sectionId
      ? {
          id: "section",
          label:
            metadata.data?.sections.find((item) => item.id === filters.sectionId)?.name ??
            "Section",
        }
      : null,
    filters.status
      ? {
          id: "status",
          label:
            STATUS_OPTIONS.find((item) => item.value === filters.status)?.label ?? filters.status,
        }
      : null,
    filters.classId ? { id: "class", label: "Class drill-down" } : null,
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
          <p className="attendance-eyebrow">Principal · Attendance</p>
          <h1>Attendance monitoring</h1>
          <p>School-wide visibility, daily records, trends, and intervention alerts.</p>
        </div>
        <AttendanceExportToolbar filters={filters} />
      </header>

      <div className="attendance-view-toggle" aria-label="Attendance view">
        <Button
          variant={filters.view === "school" ? "primary" : "secondary"}
          aria-pressed={filters.view === "school"}
          onClick={() => updateFilters({ view: "school" })}
        >
          School view
        </Button>
        <Button
          variant={filters.view === "class" ? "primary" : "secondary"}
          aria-pressed={filters.view === "class"}
          onClick={() => updateFilters({ view: "class" })}
        >
          Class view
        </Button>
      </div>

      <section aria-labelledby="attendance-filters-title">
        <h2 id="attendance-filters-title" className="attendance-visually-hidden">
          Attendance filters
        </h2>
        <FilterBar
          searchLabel="Student search"
          searchPlaceholder="Name or admission number"
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
            label="Grade"
            options={grades}
            value={filters.grade ?? "all"}
            onChange={(value) =>
              updateFilters({ grade: value === "all" ? undefined : value, sectionId: undefined })
            }
          />
          <Select
            label="Section"
            options={sections}
            value={filters.sectionId ?? "all"}
            onChange={(value) => updateFilters({ sectionId: value === "all" ? undefined : value })}
          />
          <Select
            label="Attendance status"
            options={STATUS_OPTIONS}
            value={filters.status ?? "all"}
            onChange={(value) => updateFilters({ status: value === "all" ? undefined : value })}
          />
          <Select
            label="Trend interval"
            options={INTERVAL_OPTIONS}
            value={filters.interval}
            onChange={(interval) => updateFilters({ interval })}
          />
          <Checkbox
            label="Threshold breaches only"
            checked={filters.breachesOnly}
            onChange={(event) => updateFilters({ breachesOnly: event.target.checked })}
          />
        </div>
      </section>

      {summary.isError ? (
        <p className="attendance-error" role="alert">
          Unable to load attendance summary.
        </p>
      ) : null}
      <AttendanceSummaryCards summary={summary.data} />

      {filters.view === "class" && summary.data ? (
        <Card>
          <h2>Class breakdown</h2>
          <Table caption="Attendance summary by class">
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Class</Table.HeaderCell>
                <Table.HeaderCell>Present</Table.HeaderCell>
                <Table.HeaderCell>Absent</Table.HeaderCell>
                <Table.HeaderCell>Tardy</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body columnCount={4} empty="No classes recorded in this period.">
              {summary.data.items
                .filter((item) => item.group_by === "class")
                .map((item) => (
                  <Table.Row key={item.class_id}>
                    <Table.Cell>{item.class_code}</Table.Cell>
                    <Table.Cell>{item.present_percent.toFixed(1)}%</Table.Cell>
                    <Table.Cell>{item.absent_percent.toFixed(1)}%</Table.Cell>
                    <Table.Cell>{item.late_percent.toFixed(1)}%</Table.Cell>
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
            <h2 id="daily-attendance-title">Daily attendance</h2>
            <p>{rows.length} students in the active view</p>
          </div>
          {matrix.isFetching ? <span role="status">Refreshing…</span> : null}
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
