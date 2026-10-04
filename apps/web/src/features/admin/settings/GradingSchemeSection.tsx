import { ApiError } from "@studafy/api-client";
import { Select, useToast } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { ConfirmChangeDialog } from "./ConfirmChangeDialog";
import { useUpdateSchoolSettings } from "./mutations";
import { GRADING_SCHEME_TYPES, gradingSchemeLabelKey } from "./schema";
import { SettingsCard } from "./SettingsCard";

import type { SchoolSettings } from "./queries";
import type { FormEvent } from "react";

export interface GradingSchemeSectionProps {
  settings: SchoolSettings | undefined;
  loading: boolean;
}

/**
 * How grades are displayed across report cards and gradebooks — a single school-wide format, not
 * the per-class weighted grading schemes under Grades config. Changing it re-labels every existing
 * grade the moment it saves, so it confirms first, unlike the other sections here.
 */
export function GradingSchemeSection({ settings, loading }: GradingSchemeSectionProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const updateSettings = useUpdateSchoolSettings();

  const gradingSchemeOptions = GRADING_SCHEME_TYPES.map((scheme) => ({
    value: scheme,
    label: t(gradingSchemeLabelKey(scheme)),
  }));

  const [value, setValue] = useState<(typeof GRADING_SCHEME_TYPES)[number]>("letter");
  const [confirming, setConfirming] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    if (!hydrated.current && settings) {
      setValue(settings.grading_scheme);
      hydrated.current = true;
    }
  }, [settings]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConfirming(true);
  }

  function handleConfirm() {
    updateSettings.mutate(
      { grading_scheme: value },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("adminSchool.settings.grading.updated") });
          setConfirming(false);
        },
        onError: (error) => {
          show({
            variant: "error",
            title: t("adminSchool.settings.saveFailed"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          });
          setConfirming(false);
        },
      },
    );
  }

  return (
    <>
      <SettingsCard
        title={t("adminSchool.settings.grading.title")}
        description={t("adminSchool.settings.grading.description")}
        onSubmit={handleSubmit}
        saving={updateSettings.isPending}
      >
        <Select
          label={t("adminSchool.settings.grading.label")}
          options={gradingSchemeOptions}
          value={value}
          onChange={setValue}
          helperText={t("adminSchool.settings.grading.help")}
          disabled={loading}
          required
        />
      </SettingsCard>

      <ConfirmChangeDialog
        open={confirming}
        title={t("adminSchool.settings.grading.confirmTitle")}
        loading={updateSettings.isPending}
        onConfirm={handleConfirm}
        onClose={() => setConfirming(false)}
      >
        <p>
          {t("adminSchool.settings.grading.confirmBody", {
            from: settings
              ? t(gradingSchemeLabelKey(settings.grading_scheme))
              : t("adminSchool.settings.grading.currentScheme"),
            to: t(gradingSchemeLabelKey(value)),
          })}
        </p>
      </ConfirmChangeDialog>
    </>
  );
}
