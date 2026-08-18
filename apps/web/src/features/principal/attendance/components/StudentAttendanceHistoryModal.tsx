import { PERMISSIONS } from "@studafy/constants";
import { Button, Modal } from "@studafy/ui";

import { usePermissions } from "../../../../lib/auth";
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
      title={student?.studentName ?? "Student attendance history"}
      description={
        student
          ? `${student.admissionNumber} · ${student.classCode} · ${student.attendancePercent.toFixed(1)}% attendance`
          : "Loading student attendance…"
      }
    >
      <Modal.Body>
        {profile.isPending ? <p role="status">Loading attendance history…</p> : null}
        {profile.isError || (!student && !profile.isPending) ? (
          <p role="alert">Unable to load the student history.</p>
        ) : null}
        <ol className="attendance-timeline">
          {timeline.map((entry) => (
            <li key={`${entry.recordId}-${entry.date}`}>
              <div>
                <strong>{entry.date}</strong>
                <AttendanceStatusBadge status={entry.status} />
                {entry.minutesLate ? <span>{entry.minutesLate} minutes late</span> : null}
                {entry.reason ? <small>{entry.reason}</small> : null}
                <small>
                  Version {entry.version}
                  {entry.outOfWindow ? " · Administrative override" : ""}
                </small>
              </div>
              {canCorrect ? (
                <Button variant="tertiary" onClick={() => onRequestCorrection(entry)}>
                  Request correction
                </Button>
              ) : (
                <span className="attendance-readonly-badge">Read only</span>
              )}
            </li>
          ))}
        </ol>
      </Modal.Body>
    </Modal>
  );
}
