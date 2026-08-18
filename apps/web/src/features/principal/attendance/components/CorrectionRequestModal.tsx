import { Input, Modal, Button, Select } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useCorrectAttendance } from "../hooks/useAttendanceData";

import { STATUS_LABELS } from "./DailyAttendanceGrid";

import type { AttendanceStatus, AttendanceTimelineEntry } from "../types";
import type { SelectOption } from "@studafy/ui";

const STATUS_OPTIONS = Object.entries(STATUS_LABELS).map(([value, label]) => ({
  value,
  label,
})) as SelectOption<AttendanceStatus>[];

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
  const [status, setStatus] = useState<AttendanceStatus>(entry?.status ?? "present");
  const [reason, setReason] = useState("");
  const [minutesLate, setMinutesLate] = useState("");
  const [error, setError] = useState<string>();
  const mutation = useCorrectAttendance();

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
      return setError("Choose a status different from the current status.");
    if (!trimmedReason) return setError("Enter a correction reason.");
    const parsedMinutes = Number(minutesLate);
    if (status === "late" && (!Number.isInteger(parsedMinutes) || parsedMinutes <= 0)) {
      return setError("Enter a positive number of minutes late.");
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
      title="Request attendance correction"
      description={
        entry ? `${entry.date} · Current status: ${STATUS_LABELS[entry.status]}` : undefined
      }
    >
      <Modal.Body>
        <div className="attendance-form">
          <Select
            label="Corrected status"
            options={STATUS_OPTIONS}
            value={status}
            onChange={setStatus}
          />
          {status === "late" ? (
            <Input
              label="Minutes late"
              type="number"
              min={1}
              value={minutesLate}
              onChange={(event) => setMinutesLate(event.target.value)}
              required
            />
          ) : null}
          <Input
            label="Reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            required
            helperText="This justification is added to the attendance audit history."
          />
          <p className="attendance-permission-note">
            {canOverride
              ? "You may correct records outside the standard correction window."
              : "Corrections outside the standard window require an administrator override."}
          </p>
          {error ? (
            <p role="alert" className="attendance-error">
              {error}
            </p>
          ) : null}
          {mutation.isError ? (
            <p role="alert" className="attendance-error">
              The correction was rejected. Check the correction window and your permissions.
            </p>
          ) : null}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button loading={mutation.isPending} onClick={submit}>
          Submit correction
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
