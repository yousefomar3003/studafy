import { ApiError } from "@studafy/api-client";
import { Checkbox, Input, useToast } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";

import { ConfirmChangeDialog } from "./ConfirmChangeDialog";
import { useUpdateSchoolSettings } from "./mutations";
import { attendanceAlertsSchema, fieldErrors } from "./schema";
import { SettingsCard } from "./SettingsCard";

import type { SchoolSettings } from "./queries";
import type { AttendanceAlertsValues } from "./schema";
import type { FormEvent } from "react";

const DEFAULT_VALUES: AttendanceAlertsValues = {
  attendance_alert_threshold: 75,
  absence_alert_threshold: 25,
  attendance_correction_window_hours: 48,
  parent_discipline_visibility: false,
};

export interface AttendanceAlertsSectionProps {
  settings: SchoolSettings | undefined;
  loading: boolean;
}

/**
 * Attendance/absence alert thresholds, the teacher correction window, and whether parents can see
 * their child's resolved discipline incidents. The thresholds and window only change future alerting
 * and correction behavior, so they save directly; the discipline-visibility flip changes what every
 * parent can see right now, so it confirms first — the one control in this section with a real,
 * immediate privacy consequence.
 */
export function AttendanceAlertsSection({ settings, loading }: AttendanceAlertsSectionProps) {
  const { show } = useToast();
  const updateSettings = useUpdateSchoolSettings();

  const [values, setValues] = useState<AttendanceAlertsValues>(DEFAULT_VALUES);
  const [errors, setErrors] = useState<Partial<Record<keyof AttendanceAlertsValues, string>>>({});
  const [pendingValues, setPendingValues] = useState<AttendanceAlertsValues | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    if (!hydrated.current && settings) {
      setValues({
        attendance_alert_threshold: settings.attendance_alert_threshold,
        absence_alert_threshold: settings.absence_alert_threshold,
        attendance_correction_window_hours: settings.attendance_correction_window_hours,
        parent_discipline_visibility: settings.parent_discipline_visibility,
      });
      hydrated.current = true;
    }
  }, [settings]);

  function setField<K extends keyof AttendanceAlertsValues>(
    key: K,
    value: AttendanceAlertsValues[K],
  ) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function save(next: AttendanceAlertsValues) {
    updateSettings.mutate(next, {
      onSuccess: () => {
        show({ variant: "success", title: "Attendance alerts updated" });
        setPendingValues(null);
      },
      onError: (error) => {
        show({
          variant: "error",
          title: "Couldn't save changes",
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
        setPendingValues(null);
      },
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const result = attendanceAlertsSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }

    if (
      settings &&
      result.data.parent_discipline_visibility !== settings.parent_discipline_visibility
    ) {
      setPendingValues(result.data);
      return;
    }
    save(result.data);
  }

  return (
    <>
      <SettingsCard
        title="Attendance alerts"
        description="Thresholds that trigger attendance alerts, the teacher correction window, and discipline visibility for parents."
        onSubmit={handleSubmit}
        saving={updateSettings.isPending}
      >
        <Input
          label="Attendance alert threshold (%)"
          type="number"
          min={0}
          max={100}
          value={values.attendance_alert_threshold}
          onChange={(e) => setField("attendance_alert_threshold", Number(e.target.value))}
          helperText="An alert fires when a student's attendance rate falls below this percentage."
          error={errors.attendance_alert_threshold}
          disabled={loading}
          required
        />
        <Input
          label="Absence alert threshold (%)"
          type="number"
          min={0}
          max={100}
          value={values.absence_alert_threshold}
          onChange={(e) => setField("absence_alert_threshold", Number(e.target.value))}
          helperText="An alert fires when a student's absence rate rises above this percentage."
          error={errors.absence_alert_threshold}
          disabled={loading}
          required
        />
        <Input
          label="Correction window (hours)"
          type="number"
          min={1}
          max={8760}
          value={values.attendance_correction_window_hours}
          onChange={(e) => setField("attendance_correction_window_hours", Number(e.target.value))}
          helperText="How long after a session teachers can still correct its attendance. After it, only a principal can."
          error={errors.attendance_correction_window_hours}
          disabled={loading}
          required
        />
        <Checkbox
          checked={values.parent_discipline_visibility}
          onChange={(e) => setField("parent_discipline_visibility", e.target.checked)}
          label="Parents can view their child's resolved discipline incidents"
          disabled={loading}
        />
      </SettingsCard>

      <ConfirmChangeDialog
        open={pendingValues !== null}
        title={
          pendingValues?.parent_discipline_visibility
            ? "Show discipline incidents to parents?"
            : "Hide discipline incidents from parents?"
        }
        loading={updateSettings.isPending}
        onConfirm={() => pendingValues && save(pendingValues)}
        onClose={() => setPendingValues(null)}
      >
        <p>
          {pendingValues?.parent_discipline_visibility
            ? "Every parent at this school will immediately be able to see their own child's resolved discipline incidents in the portal."
            : "Parents will immediately lose access to their child's resolved discipline incidents in the portal."}
        </p>
      </ConfirmChangeDialog>
    </>
  );
}
