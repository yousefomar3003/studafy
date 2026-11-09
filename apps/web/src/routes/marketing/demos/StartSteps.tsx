import { useId, useRef, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import type { CSSProperties, KeyboardEvent } from "react";

const STEPS = ["talk", "setup", "import", "invite", "run"] as const;
type Step = (typeof STEPS)[number];

const A = "site.marketing.about";

/**
 * "How a school starts": five steps from the first message to a full school day, on a line that
 * fills up to the chosen step. Pick a step to read it; arrow keys, Home and End move between them
 * (WAI-ARIA tabs pattern). Nothing moves on its own.
 */
export function StartSteps() {
  const { t } = useTranslation();
  const [active, setActive] = useState<Step>("talk");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();
  const index = STEPS.indexOf(active);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, at: number) => {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    let next: number | null = null;
    if (event.key === "ArrowRight") next = at + (rtl ? -1 : 1);
    if (event.key === "ArrowLeft") next = at + (rtl ? 1 : -1);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = STEPS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const clamped = Math.max(0, Math.min(STEPS.length - 1, next));
    setActive(STEPS[clamped]!);
    tabRefs.current[clamped]?.focus();
  };

  return (
    <div className="mk-steps" style={{ "--progress": index / (STEPS.length - 1) } as CSSProperties}>
      <div className="mk-steps__track" role="tablist" aria-label={t(`${A}.startTitle`)}>
        {STEPS.map((step, at) => (
          <button
            key={step}
            ref={(element) => {
              tabRefs.current[at] = element;
            }}
            type="button"
            role="tab"
            id={`${baseId}-${step}`}
            aria-selected={active === step}
            aria-controls={`${baseId}-panel`}
            tabIndex={active === step ? 0 : -1}
            data-done={at < index || undefined}
            className="mk-steps__step"
            onClick={() => setActive(step)}
            onKeyDown={(event) => onKeyDown(event, at)}
          >
            <span className="mk-steps__dot" aria-hidden="true">
              {at + 1}
            </span>
            <span className="mk-steps__name">{t(`${A}.steps.${step}.title`)}</span>
          </button>
        ))}
      </div>
      <div
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-${active}`}
        className="mk-steps__panel"
        key={active}
      >
        <p className="mk-label">{t(`${A}.stepLabel`, { number: index + 1 })}</p>
        <h3 className="mk-steps__title">{t(`${A}.steps.${active}.title`)}</h3>
        <p className="mk-steps__body">{t(`${A}.steps.${active}.body`)}</p>
      </div>
    </div>
  );
}
