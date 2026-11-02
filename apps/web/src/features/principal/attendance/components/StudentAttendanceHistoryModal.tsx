import { PERMISSIONS } from "@studafy/constants";
import { Button, Modal } from "@studafy/ui";

import { usePermissions } from "../../../../lib/auth";
import { useFormatters, useTranslation } from "../../../../lib/i18n";
import { ONE_DECIMAL_PERCENT_OPTIONS } from "../../format";
import { useRecordHistory, useStudentProfile } from "../hooks/useAttendanceData";

import { AttendanceStatusBadge } from "./DailyAttendanceGrid";

import type { AttendanceTimelineEntry } from "../types";

export interface StudentAttendanceHistoryModalProps {
  studentId: string | null;
  recordId: string | null;
  onClose: () => void;
  onRequestCorrection: (entry: AttendanceTimelineEntry) => void;
}

export function StudentAttendanceHistoryModal({
  studentId,
  recordId,
  onClose,
  onRequestCorrection,
}: StudentAttendanceHistoryModalProps) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const permissions = usePermissions();
  const canCorrect = permissions.has(PERMISSIONS.ATTENDANCE_RECORD_CORRECT);
  const profile = useStudentProfile(studentId);
  const history = useRecordHistory(recordId);
  const student = profile.data;

  const timeline =
    student?.timeline.map((entry) => {
      if (entry.recordId !== recordId || !history.data) return entry;
      const latest = history.data.entries.at(-1);
      return latest
        ? {
            ...entry,
            status: latest.status === "remote" ? entry.status : latest.status,
            minutesLate: latest.minutes_late,
            reason: latest.reason,
            version: latest.version,
            outOfWindow: latest.out_of_window,
          }
        : entry;
    }) ?? [];

  return (
    <Modal
      open={studentId !== null}
      onClose={onClose}
      title={student?.studentName ?? t("principal.attendance.history.fallbackTitle")}
      description={
        student
          ? t("principal.attendance.history.description", {
              admissionNumber: student.admissionNumber,
              classCode: student.classCode,
              percent: formatNumber(student.attendancePercent / 100, ONE_DECIMAL_PERCENT_OPTIONS),
            })
          : t("principal.attendance.history.loadingDescription")
      }
    >
      <Modal.Body>
        {profile.isPending ? (
          <p role="status">{t("principal.attendance.history.loading")}</p>
        ) : null}
        {profile.isError || (!student && !profile.isPending) ? (
          <p role="alert">{t("principal.attendance.history.error")}</p>
        ) : null}
        <ol className="attendance-timeline">
          {timeline.map((entry) => (
            <li key={`${entry.recordId}-${entry.date}`}>
              <div>
                <strong>{entry.date}</strong>
                <AttendanceStatusBadge status={entry.status} />
                {entry.minutesLate ? (
                  <span>
                    {t("principal.attendance.history.minutesLate", {
                      count: entry.minutesLate,
                      formatted: formatNumber(entry.minutesLate),
                    })}
                  </span>
                ) : null}
                {entry.reason ? <small>{entry.reason}</small> : null}
                <small>
                  {t(
                    entry.outOfWindow
                      ? "principal.attendance.history.versionOverride"
                      : "principal.attendance.history.version",
                    { version: entry.version },
                  )}
                </small>
              </div>
              {canCorrect ? (
                <Button variant="tertiary" onClick={() => onRequestCorrection(entry)}>
                  {t("principal.attendance.history.requestCorrection")}
                </Button>
              ) : (
                <span className="attendance-readonly-badge">
                  {t("principal.attendance.history.readOnly")}
                </span>
              )}
            </li>
          ))}
        </ol>
      </Modal.Body>
    </Modal>
  );
}
