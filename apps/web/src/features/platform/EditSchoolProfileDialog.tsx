import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";

import { useUpdateSchoolProfile } from "./school-admin";

import type { PlatformSchoolDetail } from "./queries";
import type { UpdateSchoolProfileBody } from "./school-admin";
import type { components } from "@studafy/api-client";
import type { SelectOption } from "@studafy/ui";

type Locale = NonNullable<UpdateSchoolProfileBody["locale"]>;
type CountryOption = components["schemas"]["CountriesResponse"]["countries"][number];
type CurrencyOption = components["schemas"]["CurrenciesResponse"]["currencies"][number];
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The default languages School settings accepts (tenancy/settings `localeEnum`). */
const LOCALES: readonly Locale[] = ["en", "ar", "fr", "es", "pt", "de"];

interface FormValues {
  name: string;
  email: string;
  countryCode: string;
  currencyCode: string;
  locale: string;
  timezone: string;
  reason: string;
}

function initialValues(school: PlatformSchoolDetail): FormValues {
  return {
    name: school.name,
    email: school.email,
    countryCode: school.countryCode,
    currencyCode: school.currencyCode,
    locale: school.locale ?? "",
    timezone: school.timezone ?? "",
    reason: "",
  };
}

/** Only the fields that differ from the school as loaded, plus the reason. */
export function profilePatch(
  school: PlatformSchoolDetail,
  values: FormValues,
): UpdateSchoolProfileBody | null {
  const body: Mutable<UpdateSchoolProfileBody> = { reason: values.reason.trim() };
  const name = values.name.trim();
  const email = values.email.trim();
  const timezone = values.timezone.trim();
  if (name !== school.name) body.name = name;
  if (email !== school.email) body.email = email;
  if (values.countryCode !== school.countryCode) body.countryCode = values.countryCode;
  if (values.currencyCode !== school.currencyCode) body.currencyCode = values.currencyCode;
  if (values.locale && values.locale !== school.locale) body.locale = values.locale as Locale;
  if (timezone && timezone !== school.timezone) body.timezone = timezone;
  return Object.keys(body).length > 1 ? body : null;
}

/**
 * Edits a school's profile from the console (`PATCH /api/platform/schools/{schoolId}/profile`):
 * name, contact email, country, currency, default language and timezone. A reason is required and
 * recorded in the audit log. The API refuses country/currency once the school has billing records.
 */
export function EditSchoolProfileDialog({
  school,
  open,
  onClose,
}: {
  school: PlatformSchoolDetail;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const update = useUpdateSchoolProfile(school.id);
  const [values, setValues] = useState<FormValues>(() => initialValues(school));

  const countries = useQuery({
    queryKey: ["lookups", "countries"],
    queryFn: async () => {
      const { data } = await api.GET("/api/lookups/countries");
      return data?.countries ?? [];
    },
    enabled: open,
  });
  const currencies = useQuery({
    queryKey: ["lookups", "currencies"],
    queryFn: async () => {
      const { data } = await api.GET("/api/lookups/currencies");
      return data?.currencies ?? [];
    },
    enabled: open,
  });

  const set = (key: keyof FormValues) => (value: string) =>
    setValues((previous) => ({ ...previous, [key]: value }));

  const patch = profilePatch(school, values);
  const reasonValid = values.reason.trim().length >= 3;
  const canSubmit = patch !== null && reasonValid && values.name.trim().length > 0;

  function close() {
    setValues(initialValues(school));
    onClose();
  }

  function submit() {
    if (!patch || !canSubmit) return;
    update.mutate(patch, {
      onSuccess: (fresh) => {
        show({ variant: "success", title: t("platform.school.editProfile.saved") });
        // Reset to the saved school, not the one this dialog opened with: reopening it must not
        // offer the old values back as a change.
        setValues(initialValues(fresh));
        onClose();
      },
      onError: (error) =>
        show({
          variant: "error",
          title: t("platform.school.editProfile.error"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        }),
    });
  }

  const countryList = (countries.data as readonly CountryOption[] | undefined) ?? [];
  const currencyList = (currencies.data as readonly CurrencyOption[] | undefined) ?? [];
  const countryOptions: SelectOption<string>[] = countryList.map((country) => ({
    value: country.alpha2_code,
    label: `${country.name} (${country.alpha2_code})`,
  }));
  if (!countryOptions.some((option) => option.value === values.countryCode)) {
    countryOptions.unshift({ value: values.countryCode, label: values.countryCode });
  }
  const currencyOptions: SelectOption<string>[] = currencyList.map((currency) => ({
    value: currency.code,
    label: `${currency.name} (${currency.code})`,
  }));
  if (!currencyOptions.some((option) => option.value === values.currencyCode)) {
    currencyOptions.unshift({ value: values.currencyCode, label: values.currencyCode });
  }
  const localeOptions: SelectOption<string>[] = [
    ...(values.locale ? [] : [{ value: "", label: t("platform.school.editProfile.notSet") }]),
    ...LOCALES.map((locale) => ({ value: locale, label: t(`platform.languages.${locale}`) })),
  ];

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("platform.school.editProfile.title")}
      description={school.name}
    >
      <Modal.Body>
        <Input
          label={t("platform.school.editProfile.name")}
          value={values.name}
          onChange={(event) => set("name")(event.target.value)}
          required
        />
        <Input
          label={t("platform.school.editProfile.email")}
          type="email"
          value={values.email}
          onChange={(event) => set("email")(event.target.value)}
          required
        />
        <Select
          label={t("platform.school.editProfile.country")}
          options={countryOptions}
          value={values.countryCode}
          onChange={set("countryCode")}
        />
        <Select
          label={t("platform.school.editProfile.currency")}
          options={currencyOptions}
          value={values.currencyCode}
          onChange={set("currencyCode")}
        />
        <p className="platform-muted">{t("platform.school.editProfile.billingLockHelp")}</p>
        <Select
          label={t("platform.school.editProfile.language")}
          options={localeOptions}
          value={values.locale}
          onChange={set("locale")}
        />
        <Input
          label={t("platform.school.editProfile.timezone")}
          helperText={t("platform.school.editProfile.timezoneHelp")}
          value={values.timezone}
          onChange={(event) => set("timezone")(event.target.value)}
        />
        <Input
          label={t("platform.school.editProfile.reason")}
          helperText={t("platform.school.editProfile.reasonHelp")}
          value={values.reason}
          onChange={(event) => set("reason")(event.target.value)}
          required
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!canSubmit}
          loading={update.isPending}
          onClick={submit}
        >
          {t("platform.school.editProfile.save")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
