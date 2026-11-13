import { Button, Card, CardBody, Input, Select } from "@studafy/ui";
import { useState } from "react";

import { HelpLink } from "../../../features/help/HelpLink";
import { onboardingStepHelpPath } from "../../../features/help/onboarding-guide-links";
import { useTranslation } from "../../../lib/i18n";
import { fieldErrors, GRADING_SCHEME_TYPES, gradingSchemeSchema } from "../schema";

import type { GradeBoundaryRow, GradingSchemeValues } from "../schema";
import type { TFunction } from "i18next";
import type { FormEvent } from "react";

/** Translation keys for each scheme type's option label — resolved with `t()` at render time. */
const SCHEME_TYPE_LABEL_KEYS: Record<(typeof GRADING_SCHEME_TYPES)[number], string> = {
  letter: "onboarding.setup.gradingScheme.types.letter",
  percentage: "onboarding.setup.gradingScheme.types.percentage",
  gpa: "onboarding.setup.gradingScheme.types.gpa",
  numeric: "onboarding.setup.gradingScheme.types.numeric",
  pass_fail: "onboarding.setup.gradingScheme.types.passFail",
};

const LETTER_TEMPLATE: GradeBoundaryRow[] = [
  { label: "A", min: 90, max: 100, gpa_points: 4.0 },
  { label: "B", min: 80, max: 89, gpa_points: 3.0 },
  { label: "C", min: 70, max: 79, gpa_points: 2.0 },
  { label: "D", min: 60, max: 69, gpa_points: 1.0 },
  { label: "F", min: 0, max: 59, gpa_points: 0.0 },
];

// The word-labelled starter templates are built per render with `t` so their editable default
// labels follow the active locale.
function passFailTemplate(t: TFunction): GradeBoundaryRow[] {
  return [
    {
      label: t("onboarding.setup.gradingScheme.templatePass"),
      min: 60,
      max: 100,
      gpa_points: null,
    },
    { label: t("onboarding.setup.gradingScheme.templateFail"), min: 0, max: 59, gpa_points: null },
  ];
}

function scoreTemplate(t: TFunction): GradeBoundaryRow[] {
  return [
    {
      label: t("onboarding.setup.gradingScheme.templateScore"),
      min: 0,
      max: 100,
      gpa_points: null,
    },
  ];
}

function templateFor(
  schemeType: (typeof GRADING_SCHEME_TYPES)[number],
  t: TFunction,
): GradeBoundaryRow[] {
  switch (schemeType) {
    case "letter":
    case "gpa":
      return LETTER_TEMPLATE;
    case "pass_fail":
      return passFailTemplate(t);
    case "percentage":
    case "numeric":
      return scoreTemplate(t);
  }
}

const EMPTY_ROW: GradeBoundaryRow = { label: "", min: 0, max: 0, gpa_points: null };

export interface GradingSchemeStepProps {
  /** The term this scheme attaches to — the wizard always creates one alongside the academic year. */
  termId: string | undefined;
  cachedValues?: GradingSchemeValues;
  onNext: (values: GradingSchemeValues) => void;
  onSkip: () => void;
  onGoToAcademicYear: () => void;
  submitting: boolean;
}

/**
 * Step 3: creates the school's first grading scheme (`POST /api/grades/config/schemes`), seeded
 * from a starter template per scheme type that the admin can edit. Schemes are versioned per term
 * server-side, so this always creates version 1 — later changes go through the academics area, not
 * back through this wizard.
 */
export function GradingSchemeStep({
  termId,
  cachedValues,
  onNext,
  onSkip,
  onGoToAcademicYear,
  submitting,
}: GradingSchemeStepProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<GradingSchemeValues>(
    () =>
      cachedValues ?? {
        name: t("onboarding.setup.gradingScheme.defaultName"),
        scheme_type: "letter",
        grade_boundaries: LETTER_TEMPLATE,
      },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!termId) {
    return (
      <Card>
        <CardBody>
          <h2>{t("onboarding.setup.gradingScheme.title")}</h2>
          <p role="alert">{t("onboarding.setup.gradingScheme.needsAcademicYear")}</p>
          <Button type="button" onClick={onGoToAcademicYear}>
            {t("onboarding.setup.goToAcademicYear")}
          </Button>
        </CardBody>
      </Card>
    );
  }

  function updateRow(index: number, patch: Partial<GradeBoundaryRow>) {
    setValues((prev) => ({
      ...prev,
      grade_boundaries: prev.grade_boundaries.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    }));
  }

  function removeRow(index: number) {
    setValues((prev) => ({
      ...prev,
      grade_boundaries: prev.grade_boundaries.filter((_, i) => i !== index),
    }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = gradingSchemeSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }
    onNext(result.data);
  }

  return (
    <Card>
      <CardBody>
        <form
          onSubmit={handleSubmit}
          noValidate
          aria-label={t("onboarding.setup.gradingScheme.title")}
        >
          <h2>{t("onboarding.setup.gradingScheme.title")}</h2>
          <p>
            <HelpLink to={onboardingStepHelpPath("gradingScheme")}>
              {t("onboarding.setup.needHelp")}
            </HelpLink>
          </p>

          <Input
            label={t("onboarding.setup.gradingScheme.name")}
            value={values.name}
            onChange={(e) => setValues((prev) => ({ ...prev, name: e.target.value }))}
            error={errors.name && t(errors.name)}
            required
          />

          <Select
            label={t("onboarding.setup.gradingScheme.type")}
            options={GRADING_SCHEME_TYPES.map((type) => ({
              value: type,
              // eslint-disable-next-line security/detect-object-injection -- `type` comes from iterating this module's own fixed `GRADING_SCHEME_TYPES` tuple, not user input
              label: t(SCHEME_TYPE_LABEL_KEYS[type]),
            }))}
            value={values.scheme_type}
            onChange={(value) =>
              setValues((prev) => ({
                ...prev,
                scheme_type: value as GradingSchemeValues["scheme_type"],
                grade_boundaries: templateFor(value as GradingSchemeValues["scheme_type"], t),
              }))
            }
            required
          />

          <fieldset>
            <legend>{t("onboarding.setup.gradingScheme.boundaries")}</legend>
            {errors.grade_boundaries ? <p role="alert">{t(errors.grade_boundaries)}</p> : null}

            {values.grade_boundaries.map((row, index) => (
              <div key={index}>
                <Input
                  label={t("onboarding.setup.gradingScheme.rowLabel", { number: index + 1 })}
                  value={row.label}
                  onChange={(e) => updateRow(index, { label: e.target.value })}
                  required
                />
                <Input
                  label={t("onboarding.setup.gradingScheme.rowMin", { number: index + 1 })}
                  type="number"
                  min={0}
                  max={100}
                  value={row.min}
                  onChange={(e) => updateRow(index, { min: Number(e.target.value) })}
                  required
                />
                <Input
                  label={t("onboarding.setup.gradingScheme.rowMax", { number: index + 1 })}
                  type="number"
                  min={0}
                  max={100}
                  value={row.max}
                  onChange={(e) => updateRow(index, { max: Number(e.target.value) })}
                  required
                />
                <Input
                  label={t("onboarding.setup.gradingScheme.rowGpa", { number: index + 1 })}
                  type="number"
                  min={0}
                  max={4.5}
                  step={0.1}
                  value={row.gpa_points ?? ""}
                  onChange={(e) =>
                    updateRow(index, {
                      gpa_points: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
                <Button
                  type="button"
                  variant="tertiary"
                  onClick={() => removeRow(index)}
                  disabled={values.grade_boundaries.length <= 1}
                >
                  {t("onboarding.setup.gradingScheme.removeRow")}
                </Button>
              </div>
            ))}

            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                setValues((prev) => ({
                  ...prev,
                  grade_boundaries: [...prev.grade_boundaries, EMPTY_ROW],
                }))
              }
            >
              {t("onboarding.setup.gradingScheme.addRow")}
            </Button>
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
