import { Input, Select, Table } from "@studafy/ui";
import { useState } from "react";

import { ExportCsvButton } from "../../../components/ExportCsvButton";
import { allRows } from "../../../lib/data-transfer";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { studentDisplayName, useAllStudents } from "../school/queries";

import type { ExportColumn } from "../../../lib/data-transfer";
import type { StudentProfile } from "../school/queries";

import "../school/principal-school.css";

const COLUMN_COUNT = 4;
const ALL = "all";
const STATUSES = [
  "applicant",
  "enrolled",
  "suspended",
  "graduated",
  "withdrawn",
  "archived",
] as const;

/** A date-of-birth value (YYYY-MM-DD, possibly with a time part) as local midnight that day, so the
 * shown date never shifts by a day across timezones. */
function calendarDay(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

/**
 * Students (`/portal/principal/students`): the school's whole student roll, searchable by name and
 * filterable by status. Read-only — enrolling and editing students is the admin's job. Admission
 * numbers are finance-visible only (see `projectStudent` in the API), so a principal sees "—".
 */
export default function PrincipalStudentsPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const students = useAllStudents();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>(ALL);

  const needle = search.trim().toLocaleLowerCase();
  const rows = (students.data ?? [])
    .filter((student) => status === ALL || student.status === status)
    .filter(
      (student) =>
        needle === "" || studentDisplayName(student).toLocaleLowerCase().includes(needle),
    )
    .sort((a, b) => studentDisplayName(a).localeCompare(studentDisplayName(b)));

  const exportColumns: ExportColumn<StudentProfile>[] = [
    { header: t("principal.students.columns.name"), value: studentDisplayName },
    {
      header: t("principal.students.columns.admissionNumber"),
      value: (student) => student.admission_number,
    },
    {
      header: t("principal.students.columns.dateOfBirth"),
      value: (student) => student.date_of_birth?.slice(0, 10) ?? "",
    },
    {
      header: t("principal.students.columns.status"),
      value: (student) => t(`principal.students.status.${student.status}`, student.status),
    },
  ];

  return (
    <>
      <h1>{t("principal.students.title")}</h1>
      <p>{t("principal.students.description")}</p>

      <div className="principal-school__filters">
        <Input
          label={t("principal.students.search")}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          label={t("principal.students.statusLabel")}
          options={[
            { value: ALL, label: t("principal.students.allStatuses") },
            ...STATUSES.map((value) => ({ value, label: t(`principal.students.status.${value}`) })),
          ]}
          value={status}
          onChange={setStatus}
        />
        <div className="principal-school__actions">
          <ExportCsvButton
            filename="students"
            columns={exportColumns}
            getRows={() => Promise.resolve(allRows(rows))}
            disabled={students.isPending}
          />
        </div>
      </div>

      <p className="principal-school__count">
        {t("principal.students.count", { count: rows.length })}
      </p>

      <Table caption={t("principal.students.caption")}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("principal.students.columns.name")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.students.columns.admissionNumber")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.students.columns.dateOfBirth")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.students.columns.status")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={students.isPending}
          empty={students.isError ? t("principal.students.error") : t("principal.students.empty")}
        >
          {rows.map((student) => (
            <Table.Row key={student.id}>
              <Table.Cell>{studentDisplayName(student)}</Table.Cell>
              <Table.Cell>{student.admission_number || "—"}</Table.Cell>
              <Table.Cell>
                {student.date_of_birth
                  ? formatDate(calendarDay(student.date_of_birth), { dateStyle: "medium" })
                  : "—"}
              </Table.Cell>
              <Table.Cell>
                {t(`principal.students.status.${student.status}`, student.status)}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </>
  );
}
