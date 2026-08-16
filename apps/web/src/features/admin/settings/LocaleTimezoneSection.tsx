import { ApiError } from "@studafy/api-client";
import { Input, Select, useToast } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";

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
      onSuccess: () => show({ variant: "success", title: "Locale and timezone updated" }),
      onError: (error) => {
        show({
          variant: "error",
          title: "Couldn't save changes",
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  return (
    <SettingsCard
      title="Locale and timezone"
      description="Default language and timezone for this school, used in emails, the portal, and timetable rendering."
      onSubmit={handleSubmit}
      saving={updateSettings.isPending}
    >
      <Select
        label="Default language"
        options={LOCALE_SELECT_OPTIONS}
        value={values.locale}
        onChange={(value) => setField("locale", value)}
        helperText="Applied to system emails and the portal's default language for new users."
        disabled={loading}
        required
      />
      <Input
        label="Timezone"
        value={values.timezone}
        onChange={(e) => setField("timezone", e.target.value)}
        helperText="IANA timezone, e.g. Africa/Casablanca. Used to render the timetable and schedule alerts."
        error={errors.timezone}
        disabled={loading}
        required
      />
    </SettingsCard>
  );
}
