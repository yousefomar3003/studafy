import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Chip, Input, Table, useToast } from "@studafy/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { api } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";
import { CorrectionRequestModal } from "../principal/attendance/components/CorrectionRequestModal";
import { studentDisplayName, todayIso, useAllStudents } from "../principal/school/queries";

import {
  sessionRecordsKey,
  useDailySessions,
  useRoster,
  useSessionRecords,
  useSubmitRegister,
} from "./queries";

import type { AttendanceRecord, AttendanceStatus, BatchRecordItem } from "./queries";
import type { AttendanceTimelineEntry } from "../principal/attendance/types";

import "./attendance-office.css";

/** The statuses the office marks, in the order the register offers them. */
const MARKABLE: readonly Exclude<AttendanceStatus, "remote">[] = [
  "present",
  "absent",
  "late",
  "excused",
];

interface Mark {
  status: Exclude<AttendanceStatus, "remote">;
  minutesLate: string;
}

const DEFAULT_MARK: Mark = { status: "present", minutesLate: "" };

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * One class's daily register (`/portal/attendance/register/:classId?date=YYYY-MM-DD`).
 *
 * Before submission every student not yet recorded gets a status (present by default, so a full
 * class is one click) and "Submit register" opens the day's session if needed, records the marks and
 * submits it. Students someone already recorded are shown as recorded and left alone. Once submitted
 * the register is read-only and each record has "Correct", which goes through the same correction
 * flow (and window) as the principal's view.
 *
 * Only the attendance officer takes registers (`attendance:record:create`); everyone else who can
 * open the attendance dashboard sees the register read-only, and "Correct" is offered only to
 * holders of `attendance:record:correct` (the officer and the principal).
 */
export default function RegisterPage() {
  const { t } = useTranslation();
  const { show } = useToast();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const { classId = "" } = useParams();
  const [params] = useSearchParams();
  const date = params.get("date") ?? todayIso();

  const klass = useQuery({
    queryKey: ["attendance-office", "class", classId],
    queryFn: async () => {
      const { data } = await api.GET("/api/academics/classes/{classId}", {
        params: { path: { classId } },
      });
      return data ?? null;
    },
  });
  const roster = useRoster(classId);
  const students = useAllStudents();
  const sessions = useDailySessions(date);
  const session = sessions.data?.get(classId);
  const records = useSessionRecords(session?.id);
  const submit = useSubmitRegister();
  const canTake = permissions.has(PERMISSIONS.ATTENDANCE_RECORD_CREATE);
  const canCorrect = permissions.has(PERMISSIONS.ATTENDANCE_RECORD_CORRECT);

  const [marks, setMarks] = useState<Map<string, Mark>>(new Map());
  const [correcting, setCorrecting] = useState<AttendanceTimelineEntry | null>(null);

  const namesById = new Map(
    (students.data ?? []).map((student) => [student.id, studentDisplayName(student)]),
  );
  const recordByStudent = new Map(
    (records.data ?? []).map((record) => [record.student_id, record]),
  );
  const rosterIds = [...(roster.data ?? [])].sort((a, b) =>
    (namesById.get(a) ?? a).localeCompare(namesById.get(b) ?? b),
  );
  const isSubmitted = session?.status === "submitted" || session?.status === "locked";
  const toMark = rosterIds.filter((id) => !recordByStudent.has(id));

  const markOf = (studentId: string) => marks.get(studentId) ?? DEFAULT_MARK;
  const setMark = (studentId: string, patch: Partial<Mark>) =>
    setMarks((current) => new Map(current).set(studentId, { ...markOf(studentId), ...patch }));

  const lateMissingMinutes = toMark.filter((id) => {
    const mark = markOf(id);
    return mark.status === "late" && !(Number.parseInt(mark.minutesLate, 10) >= 1);
  });

  const handleSubmit = () => {
    if (lateMissingMinutes.length > 0) {
      show({ variant: "error", title: t("attendanceOffice.register.lateNeedsMinutes") });
      return;
    }
    const batch: BatchRecordItem[] = toMark.map((studentId) => {
      const mark = markOf(studentId);
      return mark.status === "late"
        ? { student_id: studentId, status: "late", minutes_late: Number(mark.minutesLate) }
        : { student_id: studentId, status: mark.status };
    });
    submit.mutate(
      { classId, date, existingSession: session, records: batch },
      {
        onSuccess: () => {
          setMarks(new Map());
          show({ variant: "success", title: t("attendanceOffice.register.submitted") });
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("attendanceOffice.register.submitFailed"),
            description: apiErrorDescription(error),
          }),
      },
    );
  };

  const openCorrection = (record: AttendanceRecord) =>
    setCorrecting({
      recordId: record.id,
      date,
      // The correction form offers the four statuses the office marks; a "remote" record (taken on
      // mobile) starts the form at present.
      status: record.status === "remote" ? "present" : record.status,
      minutesLate: record.minutes_late,
      reason: record.reason,
      version: 1,
      outOfWindow: false,
    });

  const isPending = klass.isPending || roster.isPending || sessions.isPending;
  const title = t("attendanceOffice.register.title", { class: klass.data?.code ?? "", date });

  return (
    <>
      <p>
        <Link to="/portal/attendance">{t("attendanceOffice.register.back")}</Link>
      </p>
      <h1>{title}</h1>
      <p>
        {!canTake
          ? t("attendanceOffice.register.viewOnlyDescription")
          : isSubmitted
            ? t("attendanceOffice.register.submittedDescription")
            : t("attendanceOffice.register.description")}
      </p>

      {canTake && !isSubmitted && toMark.length > 0 ? (
        <div className="attendance-office__toolbar">
          <Button
            variant="secondary"
            onClick={() =>
              setMarks(new Map(toMark.map((id) => [id, { status: "present", minutesLate: "" }])))
            }
          >
            {t("attendanceOffice.register.markAllPresent")}
          </Button>
          <Button onClick={handleSubmit} loading={submit.isPending}>
            {t("attendanceOffice.register.submit", { count: toMark.length })}
          </Button>
        </div>
      ) : null}

      {/* Every student already recorded (e.g. by the teacher on mobile) but the register was never
          submitted: nothing left to mark, but it still has to be submitted to count. */}
      {canTake && !isSubmitted && session && toMark.length === 0 && rosterIds.length > 0 ? (
        <div className="attendance-office__toolbar">
          <Button onClick={handleSubmit} loading={submit.isPending}>
            {t("attendanceOffice.register.submitRecorded")}
          </Button>
        </div>
      ) : null}

      <Table caption={title}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("attendanceOffice.register.columns.student")}</Table.HeaderCell>
            <Table.HeaderCell>{t("attendanceOffice.register.columns.status")}</Table.HeaderCell>
            <Table.HeaderCell>{t("attendanceOffice.register.columns.detail")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={3}
          loading={isPending}
          empty={
            roster.isError || klass.isError
              ? t("attendanceOffice.register.error")
              : t("attendanceOffice.register.empty")
          }
        >
          {rosterIds.map((studentId) => {
            const name = namesById.get(studentId) ?? t("attendanceOffice.register.unknownStudent");
            const record = recordByStudent.get(studentId);
            if (record) {
              return (
                <Table.Row key={studentId}>
                  <Table.Cell>{name}</Table.Cell>
                  <Table.Cell>
                    <Chip variant="filled">{t(`attendanceOffice.status.${record.status}`)}</Chip>
                  </Table.Cell>
                  <Table.Cell>
                    {record.status === "late" && record.minutes_late
                      ? t("attendanceOffice.register.minutesLateValue", {
                          count: record.minutes_late,
                        })
                      : null}
                    {isSubmitted && canCorrect ? (
                      <Button
                        variant="tertiary"
                        onClick={() => openCorrection(record)}
                        aria-label={t("attendanceOffice.register.correctLabel", { student: name })}
                      >
                        {t("attendanceOffice.register.correct")}
                      </Button>
                    ) : isSubmitted ? null : (
                      <span className="attendance-office__muted">
                        {t("attendanceOffice.register.alreadyRecorded")}
                      </span>
                    )}
                  </Table.Cell>
                </Table.Row>
              );
            }

            if (!canTake) {
              return (
                <Table.Row key={studentId}>
                  <Table.Cell>{name}</Table.Cell>
                  <Table.Cell>
                    <span className="attendance-office__muted">
                      {t("attendanceOffice.register.notRecorded")}
                    </span>
                  </Table.Cell>
                  <Table.Cell />
                </Table.Row>
              );
            }

            const mark = markOf(studentId);
            return (
              <Table.Row key={studentId}>
                <Table.Cell>{name}</Table.Cell>
                <Table.Cell>
                  <div
                    role="radiogroup"
                    aria-label={t("attendanceOffice.register.statusFor", { student: name })}
                    className="attendance-office__statuses"
                  >
                    {MARKABLE.map((status) => (
                      <button
                        key={status}
                        type="button"
                        role="radio"
                        aria-checked={mark.status === status}
                        className="attendance-office__status"
                        data-status={status}
                        disabled={isSubmitted || submit.isPending}
                        onClick={() => setMark(studentId, { status })}
                      >
                        {t(`attendanceOffice.status.${status}`)}
                      </button>
                    ))}
                  </div>
                </Table.Cell>
                <Table.Cell>
                  {mark.status === "late" ? (
                    <Input
                      type="number"
                      min={1}
                      label={t("attendanceOffice.register.minutesLate")}
                      value={mark.minutesLate}
                      error={
                        lateMissingMinutes.includes(studentId) && mark.minutesLate !== ""
                          ? t("attendanceOffice.register.minutesLateInvalid")
                          : undefined
                      }
                      onChange={(event) => setMark(studentId, { minutesLate: event.target.value })}
                    />
                  ) : null}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>

      <CorrectionRequestModal
        entry={correcting}
        canOverride={permissions.has(PERMISSIONS.ATTENDANCE_CORRECTION_OVERRIDE)}
        onClose={() => setCorrecting(null)}
        onSubmitted={() => {
          setCorrecting(null);
          if (session)
            void queryClient.invalidateQueries({ queryKey: sessionRecordsKey(session.id) });
          show({ variant: "success", title: t("attendanceOffice.register.corrected") });
        }}
      />
    </>
  );
}
