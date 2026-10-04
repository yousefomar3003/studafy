import { Input, Modal, Button, Select } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../../lib/i18n";
import { useCorrectAttendance } from "../hooks/useAttendanceData";

import { STATUS_LABEL_KEYS } from "./DailyAttendanceGrid";

import type { AttendanceStatus, AttendanceTimelineEntry } from "../types";
import type { SelectOption } from "@studafy/ui";

const STATUSES = Object.keys(STATUS_LABEL_KEYS) as AttendanceStatus[];

export interface CorrectionRequestModalProps {
  entry: AttendanceTimelineEntry | null;
  canOverride: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}

export function CorrectionRequestModal({
  entry,
  canOverride,
  onClose,
  onSubmitted,
}: CorrectionRequestModalProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AttendanceStatus>(entry?.status ?? "present");
  const [reason, setReason] = useState("");
  const [minutesLate, setMinutesLate] = useState("");
  /** Translation key of the current validation error. */
  const [error, setError] = useState<string>();
  const mutation = useCorrectAttendance();
  const statusOptions: SelectOption<AttendanceStatus>[] = STATUSES.map((value) => ({
    value,
    label: t(STATUS_LABEL_KEYS[value]),
  }));

  useEffect(() => {
    if (entry) {
      setStatus(entry.status);
      setReason("");
      setMinutesLate(entry.minutesLate?.toString() ?? "");
      setError(undefined);
    }
  }, [entry]);

  const submit = () => {
    if (!entry) return;
    const trimmedReason = reason.trim();
    if (status === entry.status)
      return setError("principal.attendance.correction.errors.sameStatus");
    if (!trimmedReason) return setError("principal.attendance.correction.errors.reasonRequired");
    const parsedMinutes = Number(minutesLate);
    if (status === "late" && (!Number.isInteger(parsedMinutes) || parsedMinutes <= 0)) {
      return setError("principal.attendance.correction.errors.minutesRequired");
    }
    setError(undefined);
    mutation.mutate(
      {
        recordId: entry.recordId,
        status,
        reason: trimmedReason,
        minutesLate: status === "late" ? parsedMinutes : null,
      },
      { onSuccess: onSubmitted },
    );
  };

  return (
    <Modal
      open={entry !== null}
      onClose={onClose}
      title={t("principal.attendance.correction.title")}
      description={
        entry
          ? t("principal.attendance.correction.description", {
              date: entry.date,
              status: t(STATUS_LABEL_KEYS[entry.status]),
            })
          : undefined
      }
    >
      <Modal.Body>
        <div className="attendance-form">
          <Select
            label={t("principal.attendance.correction.correctedStatus")}
            options={statusOptions}
            value={status}
            onChange={setStatus}
          />
          {status === "late" ? (
            <Input
              label={t("principal.attendance.correction.minutesLate")}
              type="number"
              min={1}
              value={minutesLate}
              onChange={(event) => setMinutesLate(event.target.value)}
              required
            />
          ) : null}
          <Input
            label={t("principal.attendance.correction.reason")}
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            required
            helperText={t("principal.attendance.correction.reasonHelper")}
          />
          <p className="attendance-permission-note">
            {canOverride
              ? t("principal.attendance.correction.canOverride")
              : t("principal.attendance.correction.cannotOverride")}
          </p>
          {error ? (
            <p role="alert" className="attendance-error">
              {t(error)}
            </p>
          ) : null}
          {mutation.isError ? (
            <p role="alert" className="attendance-error">
              {t("principal.attendance.correction.rejected")}
            </p>
          ) : null}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="tertiary" onClick={onClose}>
          {t("principal.common.cancel")}
        </Button>
        <Button loading={mutation.isPending} onClick={submit}>
          {t("principal.attendance.correction.submit")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
