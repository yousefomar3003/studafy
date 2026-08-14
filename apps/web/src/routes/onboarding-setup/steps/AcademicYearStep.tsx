import { Button, Card, CardBody, Input } from "@studafy/ui";
import { useState } from "react";

import { academicYearSchema, fieldErrors } from "../schema";

import type { AcademicYearValues } from "../schema";
import type { FormEvent } from "react";

const EMPTY_VALUES: AcademicYearValues = { code: "", name: "", starts_on: "", ends_on: "" };

export interface AcademicYearStepProps {
  cachedValues?: AcademicYearValues;
  onNext: (values: AcademicYearValues) => void;
  onSkip: () => void;
  submitting: boolean;
}

/**
 * Step 2: creates the academic year (`POST /api/academics/years`) and, alongside it, one term
 * spanning the same dates (`POST /api/academics/years/{yearId}/terms`) — the grading-scheme step
 * needs a `term_id` to attach to, and a wizard is the wrong place to ask an admin to plan a full
 * term calendar before they've even set up grading. Multi-term calendars can be refined later from
 * the academics area; this just gets the school off zero terms.
 */
export function AcademicYearStep({
  cachedValues,
  onNext,
  onSkip,
  submitting,
}: AcademicYearStepProps) {
  const [values, setValues] = useState<AcademicYearValues>(cachedValues ?? EMPTY_VALUES);
  const [errors, setErrors] = useState<Partial<Record<keyof AcademicYearValues, string>>>({});

  function setField<K extends keyof AcademicYearValues>(key: K, value: AcademicYearValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = academicYearSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }
    onNext(result.data);
  }

  return (
    <Card>
      <CardBody>
        <form onSubmit={handleSubmit} noValidate aria-label="Academic year">
          <h2>Academic year</h2>
          <p>This becomes your school's current academic year, with one term spanning it.</p>

          <Input
            label="Year code"
            value={values.code}
            onChange={(e) => setField("code", e.target.value)}
            helperText={!errors.code ? "A short unique code, e.g. 2025-2026." : undefined}
            error={errors.code}
            required
          />

          <Input
            label="Year name"
            value={values.name}
            onChange={(e) => setField("name", e.target.value)}
            error={errors.name}
            required
          />

          <Input
            label="Start date"
            type="date"
            value={values.starts_on}
            onChange={(e) => setField("starts_on", e.target.value)}
            error={errors.starts_on}
            required
          />

          <Input
            label="End date"
            type="date"
            value={values.ends_on}
            onChange={(e) => setField("ends_on", e.target.value)}
            error={errors.ends_on}
            required
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
