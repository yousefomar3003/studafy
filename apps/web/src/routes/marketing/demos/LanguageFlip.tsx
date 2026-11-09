import { useEffect, useRef, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { prefersReducedMotion, useInView } from "./motion";

/**
 * One notification, exactly as each reader gets it. Deliberately not translated with the page: the
 * point is to show both languages, whichever one the page is read in.
 */
const NOTIFICATION = {
  en: {
    label: "English",
    title: "Omar was marked absent",
    body: "Science, period 2 · Grade 8B",
    time: "Just now",
    action: "Open",
  },
  ar: {
    label: "العربية",
    title: "تم تسجيل غياب عمر",
    body: "العلوم، الحصة الثانية · الصف الثامن ب",
    time: "الآن",
    action: "فتح",
  },
} as const;

type Language = keyof typeof NOTIFICATION;

/**
 * The same Studafy notification in English and in Arabic, switched with two buttons, so the visitor
 * sees the layout turn right-to-left rather than being told it does. On first view it shows the
 * Arabic once and comes back, within five seconds, then waits for the visitor.
 */
export function LanguageFlip() {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rootRef, 0.6);
  const [language, setLanguage] = useState<Language>("en");
  const [touched, setTouched] = useState(false);
  const playedRef = useRef(false);

  useEffect(() => {
    if (!inView || touched || playedRef.current || prefersReducedMotion()) return;
    const toArabic = window.setTimeout(() => setLanguage("ar"), 1200);
    const back = window.setTimeout(() => {
      setLanguage("en");
      playedRef.current = true;
    }, 4200);
    return () => {
      window.clearTimeout(toArabic);
      window.clearTimeout(back);
    };
  }, [inView, touched]);

  const notification = NOTIFICATION[language];

  return (
    <div className="mk-flip" ref={rootRef}>
      <div
        className="mk-flip__toggle"
        role="group"
        aria-label={t("site.marketing.home.demo.flip.toggleLabel")}
      >
        {(Object.keys(NOTIFICATION) as Language[]).map((code) => (
          <button
            key={code}
            type="button"
            lang={code}
            aria-pressed={language === code}
            className="mk-flip__option"
            onClick={() => {
              setTouched(true);
              setLanguage(code);
            }}
          >
            {NOTIFICATION[code].label}
          </button>
        ))}
      </div>

      <div className="mk-flip__stage">
        <article
          key={language}
          className="mk-flip__card"
          lang={language}
          dir={language === "ar" ? "rtl" : "ltr"}
        >
          <span className="mk-flip__icon" aria-hidden="true">
            S
          </span>
          <div className="mk-flip__text">
            <p className="mk-flip__meta">
              <span>Studafy</span>
              <span>{notification.time}</span>
            </p>
            <p className="mk-flip__title">{notification.title}</p>
            <p className="mk-flip__body">{notification.body}</p>
          </div>
          <span className="mk-flip__action" aria-hidden="true">
            {notification.action}
          </span>
        </article>
      </div>
    </div>
  );
}
