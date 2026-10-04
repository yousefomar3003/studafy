import { ApiError } from "@studafy/api-client";
import { Checkbox, Input, useToast } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

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
  const { t } = useTranslation();
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
        show({ variant: "success", title: t("adminSchool.settings.attendance.updated") });
        setPendingValues(null);
      },
      onError: (error) => {
        show({
          variant: "error",
          title: t("adminSchool.settings.saveFailed"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
        setPendingValues(null);
      },
    });
  }

  /** Field errors hold translation keys (see `schema.ts`), resolved here at render time. */
  function errorText(key: keyof AttendanceAlertsValues): string | undefined {
    // eslint-disable-next-line security/detect-object-injection -- `key` is a literal field name of this form's own value shape
    const message = errors[key];
    return message ? t(message) : undefined;
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
        title={t("adminSchool.settings.attendance.title")}
        description={t("adminSchool.settings.attendance.description")}
        onSubmit={handleSubmit}
        saving={updateSettings.isPending}
      >
        <Input
          label={t("adminSchool.settings.attendance.attendanceThreshold")}
          type="number"
          min={0}
          max={100}
          value={values.attendance_alert_threshold}
          onChange={(e) => setField("attendance_alert_threshold", Number(e.target.value))}
          helperText={t("adminSchool.settings.attendance.attendanceThresholdHelp")}
          error={errorText("attendance_alert_threshold")}
          disabled={loading}
          required
        />
        <Input
          label={t("adminSchool.settings.attendance.absenceThreshold")}
          type="number"
          min={0}
          max={100}
          value={values.absence_alert_threshold}
          onChange={(e) => setField("absence_alert_threshold", Number(e.target.value))}
          helperText={t("adminSchool.settings.attendance.absenceThresholdHelp")}
          error={errorText("absence_alert_threshold")}
          disabled={loading}
          required
        />
        <Input
          label={t("adminSchool.settings.attendance.correctionWindow")}
          type="number"
          min={1}
          max={8760}
          value={values.attendance_correction_window_hours}
          onChange={(e) => setField("attendance_correction_window_hours", Number(e.target.value))}
          helperText={t("adminSchool.settings.attendance.correctionWindowHelp")}
          error={errorText("attendance_correction_window_hours")}
          disabled={loading}
          required
        />
        <Checkbox
          checked={values.parent_discipline_visibility}
          onChange={(e) => setField("parent_discipline_visibility", e.target.checked)}
          label={t("adminSchool.settings.attendance.parentVisibility")}
          disabled={loading}
        />
      </SettingsCard>

      <ConfirmChangeDialog
        open={pendingValues !== null}
        title={
          pendingValues?.parent_discipline_visibility
            ? t("adminSchool.settings.attendance.showTitle")
            : t("adminSchool.settings.attendance.hideTitle")
        }
        loading={updateSettings.isPending}
        onConfirm={() => pendingValues && save(pendingValues)}
        onClose={() => setPendingValues(null)}
      >
        <p>
          {pendingValues?.parent_discipline_visibility
            ? t("adminSchool.settings.attendance.showBody")
            : t("adminSchool.settings.attendance.hideBody")}
        </p>
      </ConfirmChangeDialog>
    </>
  );
}
