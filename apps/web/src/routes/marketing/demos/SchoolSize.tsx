import { useId, useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import {
  browserLocaleTags,
  defaultPricingCurrency,
  loadPricingCurrency,
  PRICING_CURRENCIES,
  savePricingCurrency,
} from "./currency";

import type { PricingCurrency } from "./currency";
import type { CSSProperties } from "react";

import "./demos.css";

const MIN = 50;
const MAX = 3000;

/**
 * "What Studafy costs your school": drag the number of students and watch the cost not move. The
 * students' bar grows with the slider; the cost stays at zero, because it is. Honest, and the
 * quickest way to say "free for every size of school". The visitor can show the zero in their own
 * currency; the first one shown follows their browser's region (see `defaultPricingCurrency`).
 */
export function SchoolSize() {
  const { t } = useTranslation();
  const { formatCurrency, formatNumber } = useFormatters();
  const id = useId();
  const currencyLabelId = `${id}-currency`;
  const [students, setStudents] = useState(450);
  const [currency, setCurrency] = useState<PricingCurrency>(
    () => loadPricingCurrency() ?? defaultPricingCurrency(browserLocaleTags()),
  );
  // `count` picks the plural form; `students` is the same number, written for the reader's locale.
  const studentsText = t("marketingPages.pricing.sizeStudents", {
    count: students,
    students: formatNumber(students),
  });

  function chooseCurrency(code: PricingCurrency) {
    setCurrency(code);
    savePricingCurrency(code);
  }

  return (
    <div className="mk-size">
      <label htmlFor={id} className="mk-size__label">
        {t("marketingPages.pricing.sizeLabel")}
      </label>
      <input
        id={id}
        type="range"
        min={MIN}
        max={MAX}
        step={50}
        value={students}
        aria-valuetext={studentsText}
        onChange={(event) => setStudents(Number(event.target.value))}
        className="mk-size__range"
        style={{ "--fill": (students - MIN) / (MAX - MIN) } as CSSProperties}
      />
      <div className="mk-size__readout">
        <p className="mk-size__students">{studentsText}</p>
        <p className="mk-size__cost">
          <output htmlFor={id} className="mk-size__amount">
            {formatCurrency(0, currency, { maximumFractionDigits: 0 })}
          </output>
          <span className="mk-size__per">{t("marketingPages.pricing.perYear")}</span>
        </p>
      </div>
      <div className="mk-size__currency">
        <span id={currencyLabelId} className="mk-size__label">
          {t("marketingPages.pricing.currencyLabel")}
        </span>
        {/* Native radios: one tab stop, arrow keys move the choice, in either direction. */}
        <span
          className="mk-segmented mk-segmented--currency"
          role="radiogroup"
          aria-labelledby={currencyLabelId}
        >
          {PRICING_CURRENCIES.map((code) => (
            <label key={code} className="mk-segmented__option">
              <input
                type="radio"
                name={currencyLabelId}
                value={code}
                checked={currency === code}
                aria-label={t("marketingPages.pricing.currencyOption", {
                  name: t(`marketingPages.pricing.currencies.${code}`),
                  code,
                })}
                onChange={() => chooseCurrency(code)}
              />
              <span>{code}</span>
            </label>
          ))}
        </span>
      </div>
    </div>
  );
}
