import { ApiError } from "@studafy/api-client";
import { Select, useToast } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";

import { ConfirmChangeDialog } from "./ConfirmChangeDialog";
import { useUpdateSchoolSettings } from "./mutations";
import { GRADING_SCHEME_LABELS, GRADING_SCHEME_TYPES } from "./schema";
import { SettingsCard } from "./SettingsCard";

import type { SchoolSettings } from "./queries";
import type { FormEvent } from "react";

const GRADING_SCHEME_OPTIONS = GRADING_SCHEME_TYPES.map((scheme) => ({
  value: scheme,
  // eslint-disable-next-line security/detect-object-injection -- `scheme` comes from iterating this module's own fixed `GRADING_SCHEME_TYPES` tuple, not user input
  label: GRADING_SCHEME_LABELS[scheme],
}));

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
  const { show } = useToast();
  const updateSettings = useUpdateSchoolSettings();

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
          show({ variant: "success", title: "Grading scheme updated" });
          setConfirming(false);
        },
        onError: (error) => {
          show({
            variant: "error",
            title: "Couldn't save changes",
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
        title="Grading scheme"
        description="How grades are displayed across report cards and gradebooks school-wide."
        onSubmit={handleSubmit}
        saving={updateSettings.isPending}
      >
        <Select
          label="Grading scheme"
          options={GRADING_SCHEME_OPTIONS}
          value={value}
          onChange={setValue}
          helperText="Changes how every existing grade is labeled, not just new ones."
          disabled={loading}
          required
        />
      </SettingsCard>

      <ConfirmChangeDialog
        open={confirming}
        title="Change grading scheme?"
        loading={updateSettings.isPending}
        onConfirm={handleConfirm}
        onClose={() => setConfirming(false)}
      >
        <p>
          This changes how every existing grade at this school is displayed — from{" "}
          {settings ? GRADING_SCHEME_LABELS[settings.grading_scheme] : "the current scheme"} to{" "}
          {
            // eslint-disable-next-line security/detect-object-injection -- `value` is state set only from this module's own `GRADING_SCHEME_TYPES`-derived Select options, not user input
            GRADING_SCHEME_LABELS[value]
          }
          . It takes effect immediately across every report card and gradebook.
        </p>
      </ConfirmChangeDialog>
    </>
  );
}
