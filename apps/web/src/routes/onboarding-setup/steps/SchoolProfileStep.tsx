import { Button, Card, CardBody, Checkbox, Input, Select } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api } from "../../../lib/api";
import { fieldErrors, LOCALE_OPTIONS, schoolProfileSchema } from "../schema";

import type { SchoolProfileValues } from "../schema";
import type { FormEvent } from "react";

const LOCALE_LABELS: Record<(typeof LOCALE_OPTIONS)[number], string> = {
  en: "English",
  fr: "Français",
  ar: "العربية",
  es: "Español",
  pt: "Português",
  de: "Deutsch",
};

const FALLBACK_VALUES: SchoolProfileValues = {
  locale: "en",
  timezone: "Africa/Casablanca",
  invitation_expiry_days: 7,
  attendance_alert_threshold: 75,
  absence_alert_threshold: 25,
  parent_discipline_visibility: false,
  attendance_correction_window_hours: 48,
};

export interface SchoolProfileStepProps {
  /** Cached values from a previous visit to this step, if any — takes priority over the server fetch. */
  cachedValues?: SchoolProfileValues;
  onNext: (values: SchoolProfileValues) => void;
  onSkip: () => void;
  submitting: boolean;
}

/**
 * Step 1: the school-wide defaults an admin can set today (`PATCH /api/schools/current/settings`).
 * The backend has no editable "name / address / logo" fields yet — those are captured once at
 * registration and aren't re-editable through any endpoint — so this step is scoped to what the
 * settings API actually owns: locale, timezone, invitation expiry, and attendance thresholds.
 */
export function SchoolProfileStep({
  cachedValues,
  onNext,
  onSkip,
  submitting,
}: SchoolProfileStepProps) {
  const settingsQuery = useQuery({
    queryKey: ["schools", "current", "settings"],
    queryFn: async () => {
      const { data } = await api.GET("/api/schools/current/settings");
      return data;
    },
    enabled: !cachedValues,
  });

  const [values, setValues] = useState<SchoolProfileValues>(cachedValues ?? FALLBACK_VALUES);
  const [errors, setErrors] = useState<Partial<Record<keyof SchoolProfileValues, string>>>({});

  useEffect(() => {
    if (!cachedValues && settingsQuery.data) {
      setValues({
        locale: settingsQuery.data.locale,
        timezone: settingsQuery.data.timezone,
        invitation_expiry_days: settingsQuery.data.invitation_expiry_days,
        attendance_alert_threshold: settingsQuery.data.attendance_alert_threshold,
        absence_alert_threshold: settingsQuery.data.absence_alert_threshold,
        parent_discipline_visibility: settingsQuery.data.parent_discipline_visibility,
        attendance_correction_window_hours: settingsQuery.data.attendance_correction_window_hours,
      });
    }
  }, [cachedValues, settingsQuery.data]);

  function setField<K extends keyof SchoolProfileValues>(key: K, value: SchoolProfileValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = schoolProfileSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }
    onNext(result.data);
  }

  return (
    <Card>
      <CardBody>
        <form onSubmit={handleSubmit} noValidate aria-label="School profile">
          <h2>School profile</h2>
          <p>These defaults apply across your school and can be changed later from settings.</p>

          <Select
            label="Default language"
            options={LOCALE_OPTIONS.map((locale) => ({
              value: locale,
              // eslint-disable-next-line security/detect-object-injection -- `locale` comes from iterating this module's own fixed `LOCALE_OPTIONS` tuple, not user input
              label: LOCALE_LABELS[locale],
            }))}
            value={values.locale}
            onChange={(value) => setField("locale", value as SchoolProfileValues["locale"])}
            required
          />

          <Input
            label="Timezone"
            value={values.timezone}
            onChange={(e) => setField("timezone", e.target.value)}
            helperText={!errors.timezone ? "IANA timezone, e.g. Africa/Casablanca." : undefined}
            error={errors.timezone}
            required
          />

          <Input
            label="Invitation expiry (days)"
            type="number"
            min={1}
            max={365}
            value={values.invitation_expiry_days}
            onChange={(e) => setField("invitation_expiry_days", Number(e.target.value))}
            error={errors.invitation_expiry_days}
            required
          />

          <Input
            label="Attendance alert threshold (%)"
            type="number"
            min={0}
            max={100}
            value={values.attendance_alert_threshold}
            onChange={(e) => setField("attendance_alert_threshold", Number(e.target.value))}
            error={errors.attendance_alert_threshold}
            required
          />

          <Input
            label="Absence alert threshold (%)"
            type="number"
            min={0}
            max={100}
            value={values.absence_alert_threshold}
            onChange={(e) => setField("absence_alert_threshold", Number(e.target.value))}
            error={errors.absence_alert_threshold}
            required
          />

          <Input
            label="Attendance correction window (hours)"
            type="number"
            min={1}
            max={8760}
            value={values.attendance_correction_window_hours}
            onChange={(e) => setField("attendance_correction_window_hours", Number(e.target.value))}
            error={errors.attendance_correction_window_hours}
            required
          />

          <Checkbox
            checked={values.parent_discipline_visibility}
            onChange={(e) => setField("parent_discipline_visibility", e.target.checked)}
            label="Parents can view their child's resolved discipline incidents"
          />

          <Button type="submit" loading={submitting}>
            Save and continue
          </Button>
          <Button type="button" variant="tertiary" onClick={onSkip} disabled={submitting}>
            Skip for now
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
