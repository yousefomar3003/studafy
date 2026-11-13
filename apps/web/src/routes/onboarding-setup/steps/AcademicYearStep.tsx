import { Button, Card, CardBody, Input } from "@studafy/ui";
import { useState } from "react";

import { HelpLink } from "../../../features/help/HelpLink";
import { onboardingStepHelpPath } from "../../../features/help/onboarding-guide-links";
import { useTranslation } from "../../../lib/i18n";
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
  const { t } = useTranslation();
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
        <form
          onSubmit={handleSubmit}
          noValidate
          aria-label={t("onboarding.setup.academicYear.title")}
        >
          <h2>{t("onboarding.setup.academicYear.title")}</h2>
          <p>{t("onboarding.setup.academicYear.description")}</p>
          <p>
            <HelpLink to={onboardingStepHelpPath("academicYear")}>
              {t("onboarding.setup.needHelp")}
            </HelpLink>
          </p>

          <Input
            label={t("onboarding.setup.academicYear.code")}
            value={values.code}
            onChange={(e) => setField("code", e.target.value)}
            helperText={!errors.code ? t("onboarding.setup.academicYear.codeHelper") : undefined}
            error={errors.code && t(errors.code)}
            required
          />

          <Input
            label={t("onboarding.setup.academicYear.name")}
            value={values.name}
            onChange={(e) => setField("name", e.target.value)}
            error={errors.name && t(errors.name)}
            required
          />

          <Input
            label={t("onboarding.setup.academicYear.startDate")}
            type="date"
            value={values.starts_on}
            onChange={(e) => setField("starts_on", e.target.value)}
            error={errors.starts_on && t(errors.starts_on)}
            required
          />

          <Input
            label={t("onboarding.setup.academicYear.endDate")}
            type="date"
            value={values.ends_on}
            onChange={(e) => setField("ends_on", e.target.value)}
            error={errors.ends_on && t(errors.ends_on)}
            required
          />

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
