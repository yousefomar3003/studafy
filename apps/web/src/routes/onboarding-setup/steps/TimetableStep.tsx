import { Button, Card, CardBody, Checkbox, Input } from "@studafy/ui";
import { useState } from "react";

import { fieldErrors, timetableSchema, WEEKDAYS } from "../schema";

import type { TimetableValues } from "../schema";
import type { FormEvent } from "react";

const DEFAULT_VALUES: TimetableValues = {
  name: "Draft Timetable",
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
  const [values, setValues] = useState<TimetableValues>(cachedValues ?? DEFAULT_VALUES);
  const [errors, setErrors] = useState<Partial<Record<keyof TimetableValues, string>>>({});

  if (!yearId || !termId) {
    return (
      <Card>
        <CardBody>
          <h2>Timetable periods</h2>
          <p role="alert">Create an academic year first — a timetable belongs to a term.</p>
          <Button type="button" onClick={onGoToAcademicYear}>
            Go to academic year
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
        <form onSubmit={handleSubmit} noValidate aria-label="Timetable periods">
          <h2>Timetable periods</h2>
          <p>
            Reserve the weekly structure now — period start and end times can be finalized once you
            add classes, teachers, and rooms.
          </p>

          <Input
            label="Timetable name"
            value={values.name}
            onChange={(e) => setValues((prev) => ({ ...prev, name: e.target.value }))}
            error={errors.name}
            required
          />

          <Input
            label="Periods per day"
            type="number"
            min={1}
            max={20}
            value={values.periods_per_day}
            onChange={(e) =>
              setValues((prev) => ({ ...prev, periods_per_day: Number(e.target.value) }))
            }
            error={errors.periods_per_day}
            required
          />

          <fieldset>
            <legend>School days</legend>
            {errors.weekdays ? <p role="alert">{errors.weekdays}</p> : null}
            {WEEKDAYS.map((day) => (
              <Checkbox
                key={day.value}
                label={day.label}
                checked={values.weekdays.includes(day.value)}
                onChange={(e) => toggleWeekday(day.value, e.target.checked)}
              />
            ))}
          </fieldset>

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
