import { LOCALE_LABELS, useLocale, useTranslation } from "../lib/i18n";

import type { ChangeEvent } from "react";

import "./locale-switcher.css";

/**
 * The only UI for changing locale: a globe icon over a native `<select>` of `SUPPORTED_LOCALES`.
 * The select is transparent and covers the icon, so clicking the globe opens the platform's own
 * picker and keyboard/screen-reader behaviour is the select's. Options are labelled with each
 * locale's own name (not translated — a language names itself the same way regardless of which one
 * is currently active). `useLocale`'s `setLocale` persists the choice and drives the `<html>`
 * `lang`/`dir` swap; this component does nothing beyond reading and calling it.
 *
 * Rendered in every shell a visitor can land in — portal header, marketing header, the root nav,
 * and the sign-in page — so the language can be changed before signing in as well as after.
 */
export function LocaleSwitcher() {
  const { t } = useTranslation();
  const { locale, setLocale, supportedLocales } = useLocale();

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setLocale(event.target.value as (typeof supportedLocales)[number]);
  };

  return (
    <label className="locale-switcher" title={t("localeSwitcher.label")}>
      <span className="sf-visually-hidden">{t("localeSwitcher.label")}</span>
      <GlobeIcon />
      <select
        className="locale-switcher__select"
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

/** Globe glyph shown in place of the select's text; the select itself carries the label. */
function GlobeIcon() {
  return (
    <svg
      className="locale-switcher__icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.6 3.75 5.6 3.75 9S14.5 18.4 12 21c-2.5-2.6-3.75-5.6-3.75-9S9.5 5.6 12 3z" />
    </svg>
  );
}
