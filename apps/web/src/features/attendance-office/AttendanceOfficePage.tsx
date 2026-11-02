import { PERMISSIONS } from "@studafy/constants";
import { Card, Chip, DataGrid, Input, Table } from "@studafy/ui";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { usePermissions } from "../../lib/auth";
import { useFormatters, useTranslation } from "../../lib/i18n";
import { ONE_DECIMAL_PERCENT_OPTIONS } from "../principal/format";
import { todayIso, useClassesForTerm } from "../principal/school/queries";
import { TermPicker, useTermSelection } from "../principal/school/TermPicker";

import { attendanceRate, useAttendanceSummary, useDailySessions } from "./queries";
import { StudentSearch } from "./StudentSearch";

import type { AttendanceSession, AttendanceSummary, StudentSummaryItem } from "./queries";
import type { ChipVariant, DataGridColumn, DataGridSort } from "@studafy/ui";

import "../../components/dashboard-tile.css";
import "../principal/attendance/attendance.css";
import "../principal/school/principal-school.css";
import "./attendance-office.css";

type RegisterState = "notStarted" | "inProgress" | "submitted";

function registerState(session: AttendanceSession | undefined): RegisterState {
  if (!session) return "notStarted";
  return session.status === "submitted" || session.status === "locked" ? "submitted" : "inProgress";
}

/** A submitted register reads as done (filled); anything still to do stays outlined. */
const STATE_VARIANT: Record<RegisterState, ChipVariant> = {
  notStarted: "outlined",
  inProgress: "outlined",
  submitted: "filled",
};

/** How many at-risk students the dashboard lists before pointing at the full table. */
const AT_RISK_LIMIT = 10;

function studentPath(studentId: string): string {
  return `/portal/attendance/students/${studentId}`;
}

/**
 * The attendance dashboard (`/portal/attendance`), gated by `attendanceDashboard:view`: the
 * attendance officer, school admin, principal and teachers. Every number is read under the caller's
 * row scope, so a teacher sees only the classes they teach and the whole school for everyone else.
 *
 * Sections: student search (opens a student's attendance profile), the chosen day's numbers, every
 * class's daily register state, the students below the school's alert
 * threshold, and every student's term attendance. Only the attendance officer takes registers
 * (`attendance:record:create`); for everyone else the register links are view-only.
 */
export default function AttendanceOfficePage() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const canTake = permissions.has(PERMISSIONS.ATTENDANCE_RECORD_CREATE);
  const canSeeReports = permissions.has(PERMISSIONS.ATTENDANCE_REPORT_EXPORT);

  const selection = useTermSelection();
  const [date, setDate] = useState(todayIso());
  const termId = selection.term?.id;

  const classes = useClassesForTerm(termId);
  const sessions = useDailySessions(date);
  const day = useAttendanceSummary({ startDate: date, endDate: date }, "class");
  const students = useAttendanceSummary(termId ? { termId } : undefined, "student");

  const classList = [...(classes.data ?? [])]
    .filter((klass) => klass.status !== "cancelled")
    .sort((a, b) => a.code.localeCompare(b.code));
  const sessionByClass = sessions.data ?? new Map<string, AttendanceSession>();
  const counts = { notStarted: 0, inProgress: 0, submitted: 0 };
  for (const klass of classList) counts[registerState(sessionByClass.get(klass.id))] += 1;

  const registersPending = selection.isPending || classes.isPending || sessions.isPending;
  const registersError = classes.isError || sessions.isError;

  const studentItems = (students.data?.items ?? []) as StudentSummaryItem[];
  const threshold = students.data?.attendance_alert_threshold ?? null;
  const atRisk =
    threshold === null
      ? []
      : studentItems
          .filter((item) => item.total_records > 0 && attendanceRate(item) < threshold)
          .sort((a, b) => attendanceRate(a) - attendanceRate(b));

  return (
    <>
      <h1>{t("attendanceOffice.home.title")}</h1>
      <p>
        {canTake ? t("attendanceOffice.home.description") : t("attendanceOffice.home.viewOnly")}
      </p>

      {canSeeReports ? (
        <ul className="link-tiles">
          <li>
            <Link to="/portal/attendance/reports" className="link-tiles__item">
              {t("attendanceOffice.home.links.reports")}
            </Link>
          </li>
        </ul>
      ) : null}

      <StudentSearch />

      <div className="principal-school__filters">
        <TermPicker selection={selection} />
        <Input
          type="date"
          label={t("attendanceOffice.home.dateLabel")}
          value={date}
          onChange={(event) => event.target.value && setDate(event.target.value)}
        />
      </div>

      <section aria-labelledby="attendance-day-title" className="attendance-office__section">
        <h2 id="attendance-day-title">{t("attendanceOffice.day.title", { date })}</h2>
        <DayNumbers summary={day.data} loading={day.isPending} error={day.isError} />
      </section>

      <section aria-labelledby="attendance-registers-title" className="attendance-office__section">
        <h2 id="attendance-registers-title">{t("attendanceOffice.home.registersTitle")}</h2>
        <div className="principal-school__summary" aria-live="polite">
          {(Object.keys(counts) as RegisterState[]).map((state) => (
            <Chip key={state} variant={STATE_VARIANT[state]}>
              {t(`attendanceOffice.home.count.${state}`, { count: counts[state] })}
            </Chip>
          ))}
        </div>

        <Table caption={t("attendanceOffice.home.tableCaption", { date })}>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("attendanceOffice.home.columns.class")}</Table.HeaderCell>
              <Table.HeaderCell>{t("attendanceOffice.home.columns.register")}</Table.HeaderCell>
              <Table.HeaderCell>{t("attendanceOffice.home.columns.action")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={3}
            loading={registersPending}
            empty={
              registersError ? t("attendanceOffice.home.error") : t("attendanceOffice.home.empty")
            }
          >
            {classList.map((klass) => {
              const state = registerState(sessionByClass.get(klass.id));
              // A register nobody has started has nothing to view; only the officer can open it.
              const action = canTake ? state : state === "notStarted" ? null : "view";
              return (
                <Table.Row key={klass.id}>
                  <Table.Cell>{klass.code}</Table.Cell>
                  <Table.Cell>
                    <Chip variant={STATE_VARIANT[state]}>
                      {t(`attendanceOffice.state.${state}`)}
                    </Chip>
                  </Table.Cell>
                  <Table.Cell>
                    {action ? (
                      <Link
                        to={`/portal/attendance/register/${klass.id}?date=${date}`}
                        aria-label={t(`attendanceOffice.home.actionLabel.${action}`, {
                          class: klass.code,
                        })}
                      >
                        {t(`attendanceOffice.home.action.${action}`)}
                      </Link>
                    ) : (
                      <span className="attendance-office__muted">
                        {t("attendanceOffice.home.notTakenYet")}
                      </span>
                    )}
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      </section>

      <section aria-labelledby="attendance-at-risk-title" className="attendance-office__section">
        <h2 id="attendance-at-risk-title">{t("attendanceOffice.atRisk.title")}</h2>
        <AtRiskStudents
          items={atRisk}
          threshold={threshold}
          loading={students.isPending && termId !== undefined}
          error={students.isError}
        />
      </section>

      <section aria-labelledby="attendance-students-title" className="attendance-office__section">
        <h2 id="attendance-students-title">{t("attendanceOffice.students.title")}</h2>
        <StudentTable
          items={studentItems}
          threshold={threshold}
          loading={students.isPending && termId !== undefined}
          error={students.isError}
        />
      </section>
    </>
  );
}

function DayNumbers({
  summary,
  loading,
  error,
}: {
  summary?: AttendanceSummary;
  loading: boolean;
  error: boolean;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const totals = summary?.totals;

  if (error) return <p className="attendance-office__muted">{t("attendanceOffice.day.error")}</p>;
  if (!loading && (!totals || totals.total_records === 0)) {
    return <p className="attendance-office__muted">{t("attendanceOffice.day.empty")}</p>;
  }

  const tiles = [
    {
      id: "rate",
      label: t("attendanceOffice.metrics.rate"),
      value: totals ? formatNumber(attendanceRate(totals) / 100, ONE_DECIMAL_PERCENT_OPTIONS) : "—",
    },
    {
      id: "present",
      label: t("attendanceOffice.status.present"),
      value: totals ? formatNumber(totals.present_count) : "—",
    },
    {
      id: "absent",
      label: t("attendanceOffice.status.absent"),
      value: totals ? formatNumber(totals.absent_count) : "—",
    },
    {
      id: "late",
      label: t("attendanceOffice.status.late"),
      value: totals ? formatNumber(totals.late_count) : "—",
    },
    {
      id: "excused",
      label: t("attendanceOffice.status.excused"),
      value: totals ? formatNumber(totals.excused_count) : "—",
    },
  ];

  return (
    <div className="attendance-summary" aria-busy={loading}>
      {tiles.map((tile) => (
        <Card key={tile.id}>
          <p className="attendance-summary__label">{tile.label}</p>
          <strong className="attendance-summary__value">{tile.value}</strong>
        </Card>
      ))}
    </div>
  );
}

function AtRiskStudents({
  items,
  threshold,
  loading,
  error,
}: {
  items: StudentSummaryItem[];
  threshold: number | null;
  loading: boolean;
  error: boolean;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const percent = (value: number) => formatNumber(value / 100, ONE_DECIMAL_PERCENT_OPTIONS);

  if (threshold === null && !loading) {
    return <p className="attendance-office__muted">{t("attendanceOffice.atRisk.noThreshold")}</p>;
  }

  return (
    <>
      {threshold !== null ? (
        <p>{t("attendanceOffice.atRisk.description", { threshold: percent(threshold) })}</p>
      ) : null}
      <Table caption={t("attendanceOffice.atRisk.caption")}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("attendanceOffice.students.columns.student")}</Table.HeaderCell>
            <Table.HeaderCell>{t("attendanceOffice.metrics.rate")}</Table.HeaderCell>
            <Table.HeaderCell>{t("attendanceOffice.status.absent")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={3}
          loading={loading}
          empty={error ? t("attendanceOffice.students.error") : t("attendanceOffice.atRisk.empty")}
        >
          {items.slice(0, AT_RISK_LIMIT).map((item) => (
            <Table.Row key={item.student_id}>
              <Table.Cell>
                <Link to={studentPath(item.student_id)}>{item.student_name}</Link>
              </Table.Cell>
              <Table.Cell>{percent(attendanceRate(item))}</Table.Cell>
              <Table.Cell>{formatNumber(item.absent_count)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {items.length > AT_RISK_LIMIT ? (
        <p className="attendance-office__muted">
          {t("attendanceOffice.atRisk.more", { count: items.length - AT_RISK_LIMIT })}
        </p>
      ) : null}
    </>
  );
}

function StudentTable({
  items,
  threshold,
  loading,
  error,
}: {
  items: StudentSummaryItem[];
  threshold: number | null;
  loading: boolean;
  error: boolean;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const percent = (value: number) => formatNumber(value / 100, ONE_DECIMAL_PERCENT_OPTIONS);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<DataGridSort | null>({ columnId: "rate", direction: "asc" });

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? items.filter(
          (item) =>
            item.student_name.toLowerCase().includes(needle) ||
            item.admission_number.toLowerCase().includes(needle),
        )
      : items;
    if (!sort) return filtered;
    const value = (item: StudentSummaryItem): number | string => {
      switch (sort.columnId) {
        case "student":
          return item.student_name.toLowerCase();
        case "absent":
          return item.absent_count;
        case "late":
          return item.late_count;
        case "excused":
          return item.excused_count;
        default:
          return attendanceRate(item);
      }
    };
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      return (left < right ? -1 : left > right ? 1 : 0) * direction;
    });
  }, [items, filter, sort]);

  const columns: DataGridColumn<StudentSummaryItem>[] = [
    {
      id: "student",
      header: t("attendanceOffice.students.columns.student"),
      sortable: true,
      renderCell: (item) => <Link to={studentPath(item.student_id)}>{item.student_name}</Link>,
    },
    {
      id: "admission",
      header: t("attendanceOffice.students.columns.admissionNumber"),
      renderCell: (item) => item.admission_number,
    },
    {
      id: "rate",
      header: t("attendanceOffice.metrics.rate"),
      sortable: true,
      align: "end",
      renderCell: (item) => {
        const rate = attendanceRate(item);
        const below = threshold !== null && item.total_records > 0 && rate < threshold;
        return (
          <span data-at-risk={below || undefined}>
            {item.total_records > 0 ? percent(rate) : "—"}
          </span>
        );
      },
    },
    {
      id: "absent",
      header: t("attendanceOffice.status.absent"),
      sortable: true,
      align: "end",
      renderCell: (item) => formatNumber(item.absent_count),
    },
    {
      id: "late",
      header: t("attendanceOffice.status.late"),
      sortable: true,
      align: "end",
      renderCell: (item) => formatNumber(item.late_count),
    },
    {
      id: "excused",
      header: t("attendanceOffice.status.excused"),
      sortable: true,
      align: "end",
      renderCell: (item) => formatNumber(item.excused_count),
    },
  ];

  return (
    <>
      <div className="principal-school__filters">
        <Input
          type="search"
          label={t("attendanceOffice.students.filterLabel")}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <DataGrid
        caption={t("attendanceOffice.students.caption")}
        columns={columns}
        rows={rows}
        getRowId={(item) => item.student_id}
        getRowLabel={(item) => item.student_name}
        sort={sort}
        onSortChange={setSort}
        loading={loading}
        empty={error ? t("attendanceOffice.students.error") : t("attendanceOffice.students.empty")}
      />
    </>
  );
}
