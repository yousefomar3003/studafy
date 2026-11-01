import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Input, Modal, Select, Table, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { LinkButton } from "../../../components/LinkButton";
import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import { useTeacherRows, useUpdateTeacher } from "./queries";

import type { EmploymentStatus, TeacherRow, UpdateTeacherInput } from "./queries";

import "../../principal/sections/sections.css";
import "../../principal/years/years.css";

const COLUMN_COUNT = 6;
const EMPLOYMENT_STATUSES: readonly EmploymentStatus[] = [
  "pending",
  "active",
  "on_leave",
  "suspended",
  "terminated",
  "archived",
];

/** A `YYYY-MM-DD` value as a local calendar date. */
function parseIsoDate(value: string): Date {
  // The API sends these `format: date` fields as midnight-UTC timestamps; the date is the first ten.
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

function EditTeacherModal({
  teacher,
  onClose,
}: {
  teacher: TeacherRow | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const update = useUpdateTeacher();
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [status, setStatus] = useState<EmploymentStatus>("active");
  const [hireDate, setHireDate] = useState("");
  const [terminationDate, setTerminationDate] = useState("");

  useEffect(() => {
    if (!teacher) return;
    setEmployeeNumber(teacher.employee_number);
    setStatus(teacher.employment_status);
    // The API sends these dates as midnight-UTC timestamps; a date input takes only `YYYY-MM-DD`.
    setHireDate(teacher.hire_date?.slice(0, 10) ?? "");
    setTerminationDate(teacher.termination_date?.slice(0, 10) ?? "");
  }, [teacher]);

  // The database requires a hire date before an end date, and the end on or after the start.
  const datesValid = terminationDate === "" || (hireDate !== "" && terminationDate >= hireDate);
  const canSubmit = employeeNumber.trim() !== "" && datesValid;

  function handleSubmit() {
    if (!teacher || !canSubmit) return;
    // The API sets dates but cannot clear them, so an emptied field is simply left out.
    const body: UpdateTeacherInput = {
      employee_number: employeeNumber.trim(),
      employment_status: status,
      ...(hireDate ? { hire_date: hireDate } : {}),
      ...(terminationDate ? { termination_date: terminationDate } : {}),
    };
    update.mutate(
      { teacherId: teacher.id, body },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t("adminPeople.teachers.saved", { name: teacher.display_name }),
          });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("adminPeople.teachers.saveFailed"),
            description:
              error instanceof ApiError && error.status === 409
                ? t("adminPeople.teachers.numberTaken")
                : error instanceof ApiError
                  ? (error.detail ?? error.title)
                  : undefined,
          }),
      },
    );
  }

  return (
    <Modal
      open={teacher !== null}
      onClose={onClose}
      title={t("adminPeople.teachers.editTitle", { name: teacher?.display_name })}
    >
      <Modal.Body>
        <div className="sections-form">
          <Input
            label={t("adminPeople.teachers.employeeNumber")}
            value={employeeNumber}
            required
            maxLength={100}
            onChange={(event) => setEmployeeNumber(event.target.value)}
          />
          <Select
            label={t("adminPeople.teachers.status")}
            options={EMPLOYMENT_STATUSES.map((value) => ({
              value,
              label: t(`adminPeople.teachers.statuses.${value}`),
            }))}
            value={status}
            onChange={(value) => setStatus(value as EmploymentStatus)}
          />
          <Input
            label={t("adminPeople.teachers.hireDate")}
            type="date"
            value={hireDate}
            onChange={(event) => setHireDate(event.target.value)}
          />
          <Input
            label={t("adminPeople.teachers.terminationDate")}
            type="date"
            value={terminationDate}
            min={hireDate || undefined}
            onChange={(event) => setTerminationDate(event.target.value)}
            helperText={t("adminPeople.teachers.terminationHelper")}
            error={datesValid ? undefined : t("adminPeople.teachers.datesInvalid")}
          />
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("adminPeople.teachers.cancel")}
        </Button>
        <Button
          type="button"
          loading={update.isPending}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {t("adminPeople.teachers.save")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/**
 * Teachers (`/portal/admin/teachers`), gated on `organization:manageSettings` (each change also
 * needs `teacher:update` at the API): every teacher's employment record — employee number,
 * status (active, on leave, ...), hire and end dates. Accounts themselves (sign-in, roles) stay
 * on Users; adding a teacher stays on Members.
 */
export default function TeachersPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const teachers = useTeacherRows();
  // Each teacher's staff record (staffRecord:read; ORG_ADMIN holds it).
  const canReadRecords = usePermissions().has(PERMISSIONS.STAFF_RECORD_READ);
  const [editing, setEditing] = useState<TeacherRow | null>(null);
  const day = (value: string | null) =>
    value ? formatDate(parseIsoDate(value), { dateStyle: "medium" }) : "—";

  return (
    <>
      <h1>{t("adminPeople.teachers.title")}</h1>
      <p>{t("adminPeople.teachers.description")}</p>

      <Table caption={t("adminPeople.teachers.caption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("adminPeople.teachers.columns.name")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminPeople.teachers.employeeNumber")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminPeople.teachers.status")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminPeople.teachers.hireDate")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminPeople.teachers.terminationDate")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminPeople.teachers.columns.actions")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={teachers.isPending}
          empty={
            teachers.isError ? t("adminPeople.teachers.loadError") : t("adminPeople.teachers.empty")
          }
        >
          {(teachers.data ?? []).map((teacher) => (
            <Table.Row key={teacher.id}>
              <Table.Cell>{teacher.display_name}</Table.Cell>
              <Table.Cell>{teacher.employee_number}</Table.Cell>
              <Table.Cell>
                <span
                  className="years-page__status"
                  data-status={teacher.employment_status === "active" ? "active" : "closed"}
                >
                  {t(`adminPeople.teachers.statuses.${teacher.employment_status}`)}
                </span>
              </Table.Cell>
              <Table.Cell>{day(teacher.hire_date)}</Table.Cell>
              <Table.Cell>{day(teacher.termination_date)}</Table.Cell>
              <Table.Cell>
                <Button
                  type="button"
                  variant="tertiary"
                  aria-label={t("adminPeople.teachers.editLabel", { name: teacher.display_name })}
                  onClick={() => setEditing(teacher)}
                >
                  {t("adminPeople.teachers.edit")}
                </Button>
                {canReadRecords ? (
                  <LinkButton
                    href={`/portal/admin/staff/${teacher.user_id}/records`}
                    variant="tertiary"
                    aria-label={t("adminPeople.teachers.recordLabel", {
                      name: teacher.display_name,
                    })}
                  >
                    {t("adminPeople.teachers.record")}
                  </LinkButton>
                ) : null}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      <EditTeacherModal teacher={editing} onClose={() => setEditing(null)} />
    </>
  );
}
