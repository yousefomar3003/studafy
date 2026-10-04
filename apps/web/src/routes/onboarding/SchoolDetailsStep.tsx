import { Button, Input, Select } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../lib/api";
import { useLocale, useTranslation } from "../../lib/i18n";

import { fieldErrors, schoolDetailsSchema, slugify } from "./schema";

import type { SchoolDetails } from "./schema";
import type { Locale } from "../../lib/i18n";
import type { components } from "@studafy/api-client";
import type { FormEvent } from "react";

// openapi-fetch's generated response arrays are `readonly` tuples that lose their prototype
// methods when TS widens them alongside a `?? []` fallback — same gap noted in
// DeviceSessionsPanel.tsx. Casting to the named component type restores `.map()`.
type CountryOption = components["schemas"]["CountriesResponse"]["countries"][number];
type CurrencyOption = components["schemas"]["CurrenciesResponse"]["currencies"][number];

/**
 * Display name for an ISO region/currency code in the active locale. English keeps the API's own
 * lookup name; other locales use `Intl.DisplayNames`, falling back to the API name when the runtime
 * has no entry for the code.
 */
function displayName(
  locale: Locale,
  type: "region" | "currency",
  code: string,
  apiName: string,
): string {
  if (locale === "en") return apiName;
  try {
    return new Intl.DisplayNames([locale], { type, fallback: "none" }).of(code) ?? apiName;
  } catch {
    return apiName;
  }
}

export interface SchoolDetailsStepProps {
  defaultValues: SchoolDetails;
  /** Field errors surfaced by the server after a failed submit from a later step (e.g. a duplicate slug). */
  serverErrors?: Partial<Record<keyof SchoolDetails, string>>;
  onNext: (values: SchoolDetails) => void;
}

/** Step 1: the school's own details — name, slug, contact email, country, and default currency. */
export function SchoolDetailsStep({ defaultValues, serverErrors, onNext }: SchoolDetailsStepProps) {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const [values, setValues] = useState(defaultValues);
  const [slugTouched, setSlugTouched] = useState(defaultValues.slug !== "");
  const [errors, setErrors] = useState<Partial<Record<keyof SchoolDetails, string>>>(
    serverErrors ?? {},
  );

  const countriesQuery = useQuery({
    queryKey: ["lookups", "countries"],
    queryFn: async () => {
      const { data } = await api.GET("/api/lookups/countries");
      return data?.countries ?? [];
    },
  });
  const currenciesQuery = useQuery({
    queryKey: ["lookups", "currencies"],
    queryFn: async () => {
      const { data } = await api.GET("/api/lookups/currencies");
      return data?.currencies ?? [];
    },
  });

  function setField<K extends keyof SchoolDetails>(key: K, value: SchoolDetails[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      // eslint-disable-next-line security/detect-object-injection -- `key` is `keyof SchoolDetails`, a fixed set of literal field names, not user-controlled
      delete next[key];
      return next;
    });
  }

  function handleNameChange(name: string) {
    setValues((prev) => ({
      ...prev,
      school_name: name,
      slug: slugTouched ? prev.slug : slugify(name),
    }));
    setErrors((prev) => ({ ...prev, school_name: undefined, slug: undefined }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = schoolDetailsSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }
    onNext(result.data);
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-label={t("onboarding.schoolDetails.title")}>
      <h2>{t("onboarding.schoolDetails.title")}</h2>

      <Input
        label={t("onboarding.schoolDetails.schoolName")}
        value={values.school_name}
        onChange={(e) => handleNameChange(e.target.value)}
        error={errors.school_name && t(errors.school_name)}
        required
      />

      <Input
        label={t("onboarding.schoolDetails.slug")}
        prefix="studafy.app/"
        value={values.slug}
        onChange={(e) => {
          setSlugTouched(true);
          setField("slug", e.target.value.toLowerCase());
        }}
        helperText={!errors.slug ? t("onboarding.schoolDetails.slugHelper") : undefined}
        error={errors.slug && t(errors.slug)}
        required
      />

      <Input
        label={t("onboarding.schoolDetails.contactEmail")}
        type="email"
        value={values.email}
        onChange={(e) => setField("email", e.target.value)}
        helperText={!errors.email ? t("onboarding.schoolDetails.contactEmailHelper") : undefined}
        error={errors.email && t(errors.email)}
        required
      />

      <Select
        label={t("onboarding.schoolDetails.country")}
        placeholder={
          countriesQuery.isPending
            ? t("onboarding.schoolDetails.loadingCountries")
            : t("onboarding.schoolDetails.selectCountry")
        }
        options={((countriesQuery.data as readonly CountryOption[] | undefined) ?? []).map((c) => ({
          value: c.id,
          label: t("onboarding.schoolDetails.codedOption", {
            name: displayName(locale, "region", c.alpha2_code, c.name),
            code: c.alpha2_code,
          }),
        }))}
        value={values.country_id || undefined}
        onChange={(value) => setField("country_id", value)}
        disabled={countriesQuery.isPending}
        error={errors.country_id && t(errors.country_id)}
        required
      />

      <Select
        label={t("onboarding.schoolDetails.currency")}
        placeholder={
          currenciesQuery.isPending
            ? t("onboarding.schoolDetails.loadingCurrencies")
            : t("onboarding.schoolDetails.selectCurrency")
        }
        options={((currenciesQuery.data as readonly CurrencyOption[] | undefined) ?? []).map(
          (c) => ({
            value: c.id,
            label: t("onboarding.schoolDetails.codedOption", {
              name: displayName(locale, "currency", c.code, c.name),
              code: c.code,
            }),
          }),
        )}
        value={values.default_currency_id || undefined}
        onChange={(value) => setField("default_currency_id", value)}
        disabled={currenciesQuery.isPending}
        error={errors.default_currency_id && t(errors.default_currency_id)}
        required
      />

      <Button type="submit">{t("onboarding.common.next")}</Button>
    </form>
  );
}
