import { Card, Chip, Table } from "@studafy/ui";
import { Link, useParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../lib/i18n";
import { ONE_DECIMAL_PERCENT_OPTIONS } from "../principal/format";
import { studentDisplayName } from "../principal/school/queries";
import { TermPicker, useTermSelection } from "../principal/school/TermPicker";

import { attendanceRate, useAttendanceSummary, useStudent, useStudentAttendance } from "./queries";
import { StudentSearch } from "./StudentSearch";

import type { ChipVariant } from "@studafy/ui";

import "../principal/attendance/attendance.css";
import "../principal/school/principal-school.css";
import "./attendance-office.css";

const STATUS_VARIANT: Record<string, ChipVariant> = {
  present: "filled",
  remote: "filled",
  late: "outlined",
  excused: "outlined",
  absent: "outlined",
};

/**
 * One student's attendance (`/portal/attendance/students/:studentId`), gated by
 * `attendanceDashboard:view`: the term's rate and counts, then every class session in the term with
 * the status recorded, newest first. Read under the caller's row scope, so a teacher sees only the
 * sessions of classes they teach. View-only for every role.
 */
export default function StudentAttendancePage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { studentId = "" } = useParams();
  const selection = useTermSelection();
  const term = selection.term;

  const student = useStudent(studentId);
  const summary = useAttendanceSummary(
    term ? { termId: term.id } : undefined,
    "student",
    studentId,
  );
  const records = useStudentAttendance(studentId, term?.starts_on, term?.ends_on);

  const totals = summary.data?.totals;
  const hasRecords = (totals?.total_records ?? 0) > 0;
  const name = student.data ? studentDisplayName(student.data) : "";
  const percent = (value: number) => formatNumber(value / 100, ONE_DECIMAL_PERCENT_OPTIONS);

  const tiles = [
    {
      id: "rate",
      label: t("attendanceOffice.metrics.rate"),
      value: totals && hasRecords ? percent(attendanceRate(totals)) : "—",
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
    <>
      <p>
        <Link to="/portal/attendance">{t("attendanceOffice.register.back")}</Link>
      </p>
      <h1>{student.isError ? t("attendanceOffice.student.notFound") : name || "…"}</h1>
      {student.data ? (
        <p className="attendance-office__muted">
          {t("attendanceOffice.student.admissionNumber", {
            number: student.data.admission_number,
          })}
        </p>
      ) : null}

      <StudentSearch />

      <div className="principal-school__filters">
        <TermPicker selection={selection} />
      </div>

      <section aria-labelledby="student-term-title" className="attendance-office__section">
        <h2 id="student-term-title">
          {t("attendanceOffice.student.termTitle", { term: term?.name ?? "" })}
        </h2>
        {summary.isError ? (
          <p className="attendance-office__muted">{t("attendanceOffice.student.error")}</p>
        ) : (
          <div className="attendance-summary" aria-busy={summary.isPending}>
            {tiles.map((tile) => (
              <Card key={tile.id}>
                <p className="attendance-summary__label">{tile.label}</p>
                <strong className="attendance-summary__value">{tile.value}</strong>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="student-history-title" className="attendance-office__section">
        <h2 id="student-history-title">{t("attendanceOffice.student.historyTitle")}</h2>
        <Table caption={t("attendanceOffice.student.historyTitle")}>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("attendanceOffice.student.columns.date")}</Table.HeaderCell>
              <Table.HeaderCell>{t("attendanceOffice.student.columns.class")}</Table.HeaderCell>
              <Table.HeaderCell>{t("attendanceOffice.student.columns.status")}</Table.HeaderCell>
              <Table.HeaderCell>{t("attendanceOffice.student.columns.detail")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={4}
            loading={records.isPending && term !== undefined}
            empty={
              records.isError
                ? t("attendanceOffice.student.error")
                : t("attendanceOffice.student.historyEmpty")
            }
          >
            {(records.data ?? []).map((record) => (
              <Table.Row key={record.id}>
                <Table.Cell>{record.session_date}</Table.Cell>
                <Table.Cell>
                  {record.period === null
                    ? record.class_code
                    : t("attendanceOffice.student.classPeriod", {
                        class: record.class_code,
                        period: record.period,
                      })}
                </Table.Cell>
                <Table.Cell>
                  <Chip variant={STATUS_VARIANT[record.status] ?? "outlined"}>
                    {t(`attendanceOffice.status.${record.status}`)}
                  </Chip>
                </Table.Cell>
                <Table.Cell>
                  {record.status === "late" && record.minutes_late
                    ? t("attendanceOffice.register.minutesLateValue", {
                        count: record.minutes_late,
                      })
                    : (record.reason ?? null)}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </section>
    </>
  );
}
