import { LOCALE_LABELS, useLocale, useTranslation } from "../../lib/i18n";

import type { ChangeEvent } from "react";

/**
 * The only UI for changing locale: a native `<select>` over `SUPPORTED_LOCALES`, labelled with each
 * locale's own name (not translated — a language names itself the same way regardless of which one
 * is currently active). `useLocale`'s `setLocale` persists the choice and drives the `<html>`
 * `lang`/`dir` swap; this component does nothing beyond reading and calling it.
 */
export function LocaleSwitcher() {
  const { t } = useTranslation();
  const { locale, setLocale, supportedLocales } = useLocale();

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setLocale(event.target.value as (typeof supportedLocales)[number]);
  };

  return (
    <label className="portal-locale-switcher">
      <span className="sf-visually-hidden">{t("localeSwitcher.label")}</span>
      <select
        className="portal-locale-switcher__select"
        value={locale}
        onChange={handleChange}
        aria-label={t("localeSwitcher.label")}
      >
        {supportedLocales.map((code) => (
          <option key={code} value={code}>
            {/* eslint-disable-next-line security/detect-object-injection -- `code` iterates `supportedLocales`, a closed union of `LOCALE_LABELS`' own keys */}
            {LOCALE_LABELS[code]}
          </option>
        ))}
      </select>
    </label>
  );
}
