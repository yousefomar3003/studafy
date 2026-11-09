import { useEffect, useRef, useState } from "react";

import { useTranslation } from "../../lib/i18n";

import type { CSSProperties } from "react";

// Translation keys only: the copy lives in `locales/{en,ar}/site.json` under `site.marketing.home.day`.
const DAY = ["register", "late", "homework", "marks", "payment", "home", "study"] as const;

/** How long each moment of the day stays highlighted. */
const STEP_MS = 2600;

/**
 * "A Tuesday at a school on Studafy": the hero's table of real moments in a school day and who does
 * each. The rows settle in one after another on load, then a highlight steps through the day, one
 * moment at a time, so the table reads as the day passing. The highlight pauses while the visitor
 * points at or tabs into the table, stops while the table is off screen, has its own Pause button,
 * and never runs for visitors who prefer reduced motion. It is decoration only: the table reads the same without it.
 */
export function SchoolDay() {
  const { t } = useTranslation();
  const tableRef = useRef<HTMLTableElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(false);
  // The visitor's own Pause (WCAG 2.2.2: motion that starts by itself can be stopped).
  const [stopped, setStopped] = useState(false);
  // Only true once motion is allowed and observable, so the Pause button shows only when it does
  // something.
  const [canAnimate, setCanAnimate] = useState(false);

  useEffect(() => {
    const table = tableRef.current;
    if (!table || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    setCanAnimate(true);
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry?.isIntersecting ?? false),
    );
    observer.observe(table);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || paused || stopped) return;
    const timer = window.setInterval(
      () => setActive((current) => (current === null ? 0 : (current + 1) % DAY.length)),
      // The first step waits for the rows to finish settling in.
      active === null ? 1400 : STEP_MS,
    );
    return () => window.clearInterval(timer);
  }, [visible, paused, stopped, active]);

  return (
    <figure className="mk-day">
      <figcaption className="mk-day__title">
        <span>{t("site.marketing.home.dayTitle")}</span>
        {canAnimate ? (
          <button
            type="button"
            className="mk-text-button"
            onClick={() => setStopped((current) => !current)}
          >
            {stopped ? t("site.marketing.home.dayPlay") : t("site.marketing.home.dayPause")}
          </button>
        ) : null}
      </figcaption>
      <table
        ref={tableRef}
        className="mk-day__table"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
      >
        <thead className="sf-visually-hidden">
          <tr>
            <th scope="col">{t("site.marketing.home.dayColumns.time")}</th>
            <th scope="col">{t("site.marketing.home.dayColumns.what")}</th>
            <th scope="col">{t("site.marketing.home.dayColumns.who")}</th>
          </tr>
        </thead>
        <tbody>
          {DAY.map((id, index) => (
            <tr
              key={id}
              className="mk-day__row"
              data-active={active === index ? "true" : undefined}
              style={{ "--i": index } as CSSProperties}
            >
              <td className="mk-day__time">
                <time>{t(`site.marketing.home.day.${id}.time`)}</time>
              </td>
              <td className="mk-day__what">{t(`site.marketing.home.day.${id}.what`)}</td>
              <td className="mk-day__who">{t(`site.marketing.home.day.${id}.who`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
