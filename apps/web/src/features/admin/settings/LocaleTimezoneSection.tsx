import { ApiError } from "@studafy/api-client";
import { Input, Select, useToast } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useUpdateSchoolSettings } from "./mutations";
import { fieldErrors, LOCALE_LABELS, LOCALE_OPTIONS, localeTimezoneSchema } from "./schema";
import { SettingsCard } from "./SettingsCard";

import type { SchoolSettings } from "./queries";
import type { LocaleTimezoneValues } from "./schema";
import type { FormEvent } from "react";

const LOCALE_SELECT_OPTIONS = LOCALE_OPTIONS.map((locale) => ({
  value: locale,
  // eslint-disable-next-line security/detect-object-injection -- `locale` comes from iterating this module's own fixed `LOCALE_OPTIONS` tuple, not user input
  label: LOCALE_LABELS[locale],
}));

export interface LocaleTimezoneSectionProps {
  settings: SchoolSettings | undefined;
  loading: boolean;
}

/** Default language and IANA timezone for the school — used across emails, the portal UI, and
 * timetable rendering. Neither is retroactive to anything already recorded, so no confirm needed. */
export function LocaleTimezoneSection({ settings, loading }: LocaleTimezoneSectionProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const updateSettings = useUpdateSchoolSettings();

  const [values, setValues] = useState<LocaleTimezoneValues>({ locale: "en", timezone: "" });
  const [errors, setErrors] = useState<Partial<Record<keyof LocaleTimezoneValues, string>>>({});
  const hydrated = useRef(false);

  useEffect(() => {
    if (!hydrated.current && settings) {
      setValues({ locale: settings.locale, timezone: settings.timezone });
      hydrated.current = true;
    }
  }, [settings]);

  function setField<K extends keyof LocaleTimezoneValues>(key: K, value: LocaleTimezoneValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const result = localeTimezoneSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }

    updateSettings.mutate(result.data, {
      onSuccess: () =>
        show({ variant: "success", title: t("adminSchool.settings.locale.updated") }),
      onError: (error) => {
        show({
          variant: "error",
          title: t("adminSchool.settings.saveFailed"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  return (
    <SettingsCard
      title={t("adminSchool.settings.locale.title")}
      description={t("adminSchool.settings.locale.description")}
      onSubmit={handleSubmit}
      saving={updateSettings.isPending}
    >
      <Select
        label={t("adminSchool.settings.locale.language")}
        options={LOCALE_SELECT_OPTIONS}
        value={values.locale}
        onChange={(value) => setField("locale", value)}
        helperText={t("adminSchool.settings.locale.languageHelp")}
        disabled={loading}
        required
      />
      <Input
        label={t("adminSchool.settings.locale.timezone")}
        value={values.timezone}
        onChange={(e) => setField("timezone", e.target.value)}
        helperText={t("adminSchool.settings.locale.timezoneHelp")}
        error={errors.timezone ? t(errors.timezone) : undefined}
        disabled={loading}
        required
      />
    </SettingsCard>
  );
}
