import { Button, Card, CardBody, Checkbox, Input } from "@studafy/ui";
import { useState } from "react";

import { HelpLink } from "../../../features/help/HelpLink";
import { onboardingStepHelpPath } from "../../../features/help/onboarding-guide-links";
import { useTranslation } from "../../../lib/i18n";
import { fieldErrors, timetableSchema, WEEKDAYS } from "../schema";

import type { TimetableValues } from "../schema";
import type { FormEvent } from "react";

/** Starting values; `name` is filled with the translated default timetable name at render time. */
const DEFAULT_VALUES: Omit<TimetableValues, "name"> = {
  periods_per_day: 6,
  weekdays: [1, 2, 3, 4, 5],
};

export interface TimetableStepProps {
  /** The wizard's academic year/term — a timetable version always belongs to one. */
  yearId: string | undefined;
  termId: string | undefined;
  cachedValues?: TimetableValues;
  onNext: (values: TimetableValues) => void;
  onSkip: () => void;
  onGoToAcademicYear: () => void;
  submitting: boolean;
}

/**
 * Step 4: creates a draft timetable version (`POST /api/academics/timetable-versions`) for the
 * term. The backend only schedules class/teacher/room slots on top of a version — there's no
 * clock-time "Period 1 = 08:00-08:45" table — so the period count and weekday coverage collected
 * here describe the *intended* weekly structure and are kept in the wizard's own progress only.
 * Actual period times get set once classes, teachers, and rooms exist to schedule.
 */
export function TimetableStep({
  yearId,
  termId,
  cachedValues,
  onNext,
  onSkip,
  onGoToAcademicYear,
  submitting,
}: TimetableStepProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<TimetableValues>(
    () => cachedValues ?? { name: t("onboarding.setup.timetable.defaultName"), ...DEFAULT_VALUES },
  );
  const [errors, setErrors] = useState<Partial<Record<keyof TimetableValues, string>>>({});

  if (!yearId || !termId) {
    return (
      <Card>
        <CardBody>
          <h2>{t("onboarding.setup.timetable.title")}</h2>
          <p role="alert">{t("onboarding.setup.timetable.needsAcademicYear")}</p>
          <Button type="button" onClick={onGoToAcademicYear}>
            {t("onboarding.setup.goToAcademicYear")}
          </Button>
        </CardBody>
      </Card>
    );
  }

  function toggleWeekday(day: number, checked: boolean) {
    setValues((prev) => ({
      ...prev,
      weekdays: checked ? [...prev.weekdays, day].sort() : prev.weekdays.filter((d) => d !== day),
    }));
    setErrors((prev) => ({ ...prev, weekdays: undefined }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = timetableSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }
    onNext(result.data);
  }

  return (
    <Card>
      <CardBody>
        <form onSubmit={handleSubmit} noValidate aria-label={t("onboarding.setup.timetable.title")}>
          <h2>{t("onboarding.setup.timetable.title")}</h2>
          <p>{t("onboarding.setup.timetable.description")}</p>
          <p>
            <HelpLink to={onboardingStepHelpPath("timetable")}>
              {t("onboarding.setup.needHelp")}
            </HelpLink>
          </p>

          <Input
            label={t("onboarding.setup.timetable.name")}
            value={values.name}
            onChange={(e) => setValues((prev) => ({ ...prev, name: e.target.value }))}
            error={errors.name && t(errors.name)}
            required
          />

          <Input
            label={t("onboarding.setup.timetable.periodsPerDay")}
            type="number"
            min={1}
            max={20}
            value={values.periods_per_day}
            onChange={(e) =>
              setValues((prev) => ({ ...prev, periods_per_day: Number(e.target.value) }))
            }
            error={errors.periods_per_day && t(errors.periods_per_day)}
            required
          />

          <fieldset>
            <legend>{t("onboarding.setup.timetable.schoolDays")}</legend>
            {errors.weekdays ? <p role="alert">{t(errors.weekdays)}</p> : null}
            {WEEKDAYS.map((day) => (
              <Checkbox
                key={day.value}
                label={t(day.labelKey)}
                checked={values.weekdays.includes(day.value)}
                onChange={(e) => toggleWeekday(day.value, e.target.checked)}
              />
            ))}
          </fieldset>

          <Button type="submit" loading={submitting}>
            {t("onboarding.setup.saveAndContinue")}
          </Button>
          <Button type="button" variant="tertiary" onClick={onSkip} disabled={submitting}>
            {t("onboarding.setup.skipForNow")}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
