import { useId, useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import type { CSSProperties } from "react";

const MIN = 50;
const MAX = 3000;

/**
 * "What Studafy costs your school": drag the number of students and watch the cost not move. The
 * students' bar grows with the slider; the cost stays at zero, because it is. Honest, and the
 * quickest way to say "free for every size of school".
 */
export function SchoolSize() {
  const { t } = useTranslation();
  const { formatCurrency, formatNumber } = useFormatters();
  const id = useId();
  const [students, setStudents] = useState(450);
  // `count` picks the plural form; `students` is the same number, written for the reader's locale.
  const studentsText = t("site.marketing.pricing.sizeStudents", {
    count: students,
    students: formatNumber(students),
  });

  return (
    <div className="mk-size">
      <label htmlFor={id} className="mk-size__label">
        {t("site.marketing.pricing.sizeLabel")}
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
            {formatCurrency(0, "JOD", { maximumFractionDigits: 0 })}
          </output>
          <span className="mk-size__per">{t("site.marketing.pricing.perYear")}</span>
        </p>
      </div>
    </div>
  );
}
