import { useEffect, useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

/** Example data: a made-up ID, shown as Studafy masks it (the last four characters only). */
const NATIONAL_ID = "9881204471";
const MASK = "•••• 4471";

/** How long a revealed value stays on screen before it is masked again. */
const SHOW_MS = 6000;

/**
 * A sensitive field as staff meet it: masked until someone presses Reveal, and every reveal written
 * to the audit log with who and when. The value hides itself again after a few seconds, as the real
 * one does on screen. Example data only.
 */
export function SensitiveDemo() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const [shown, setShown] = useState(false);
  const [log, setLog] = useState<Date[]>([]);

  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(false), SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);

  const toggle = () => {
    if (!shown) setLog((entries) => [new Date(), ...entries].slice(0, 3));
    setShown((current) => !current);
  };

  return (
    <div className="mk-secret">
      <p className="mk-screen__title">{t("site.marketing.home.demo.sensitive.recordTitle")}</p>
      <dl className="mk-secret__fields">
        <div>
          <dt>{t("site.marketing.home.demo.sensitive.bloodType")}</dt>
          <dd>A+</dd>
        </div>
        <div>
          <dt>{t("site.marketing.home.demo.sensitive.nationalId")}</dt>
          <dd className="mk-secret__value">
            <span className="mk-secret__text" data-shown={shown} dir="ltr">
              {shown ? NATIONAL_ID : MASK}
            </span>
            <button type="button" className="mk-mini-button" onClick={toggle}>
              {shown
                ? t("site.marketing.home.demo.sensitive.hide")
                : t("site.marketing.home.demo.sensitive.reveal")}
            </button>
          </dd>
        </div>
      </dl>

      <p className="mk-screen__title">{t("site.marketing.home.demo.sensitive.auditTitle")}</p>
      <ol className="mk-secret__log" aria-live="polite">
        {log.length === 0 ? (
          <li className="mk-screen__meta">{t("site.marketing.home.demo.sensitive.auditEmpty")}</li>
        ) : (
          log.map((entry) => (
            <li key={entry.getTime()} className="mk-secret__entry">
              {t("site.marketing.home.demo.sensitive.auditEntry", {
                time: formatDate(entry, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
              })}
            </li>
          ))
        )}
      </ol>
      <p className="mk-screen__meta">{t("site.marketing.home.demo.sensitive.hint")}</p>
    </div>
  );
}
