import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { prefersReducedMotion, useInView } from "./motion";

import type { CSSProperties } from "react";

const STUDENTS = ["omar", "lina", "yousef", "sara", "adam"] as const;
const STATUSES = ["present", "late", "absent"] as const;

type Student = (typeof STUDENTS)[number];
type Status = (typeof STATUSES)[number];

interface Notice {
  id: number;
  student: Student;
  status: Status;
}

const ALL_PRESENT: Record<Student, Status> = {
  omar: "present",
  lina: "present",
  yousef: "present",
  sara: "present",
  adam: "present",
};

/** What plays once when the demo first comes into view, until the visitor touches it. */
const AUTOPLAY: readonly [number, Student, Status][] = [
  [900, "omar", "absent"],
  [2600, "lina", "late"],
];

/**
 * "Take the register": a teacher's register, a parent's phone and the attendance office's numbers,
 * side by side. Marking a student late or absent sends their parent a notification and moves the
 * counts, which is what one shared system means in practice. On first view it marks two students
 * by itself, once, then waits for the visitor; it never loops. Example data only.
 */
export function RegisterDemo() {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rootRef);
  const [marks, setMarks] = useState<Record<Student, Status>>(ALL_PRESENT);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [touched, setTouched] = useState(false);
  // Set once the autoplay has run to the end, so it never plays twice.
  const playedRef = useRef(false);
  const nextId = useRef(0);
  const baseId = useId();

  // The marks as of the last change, so a mark compares against them without side effects inside
  // a state updater (which React may run twice).
  const marksRef = useRef(marks);
  const mark = useCallback((student: Student, status: Status) => {
    if (marksRef.current[student] === status) return;
    const next = { ...marksRef.current, [student]: status };
    marksRef.current = next;
    nextId.current += 1;
    const notice = { id: nextId.current, student, status };
    setMarks(next);
    setNotices((list) => [notice, ...list].slice(0, 3));
  }, []);

  useEffect(() => {
    if (!inView || touched || playedRef.current || prefersReducedMotion()) return;
    let fired = 0;
    const timers = AUTOPLAY.map(([delay, student, status]) =>
      window.setTimeout(() => {
        mark(student, status);
        fired += 1;
        if (fired === AUTOPLAY.length) playedRef.current = true;
      }, delay),
    );
    // Scrolled away (or the effect re-run) before the end: the rest plays next time it is in view.
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [inView, touched, mark]);

  const reset = () => {
    setTouched(true);
    marksRef.current = ALL_PRESENT;
    setMarks(ALL_PRESENT);
    setNotices([]);
  };

  const counts = STATUSES.map((status) => ({
    status,
    count: STUDENTS.filter((student) => marks[student] === status).length,
  }));
  const latest = notices[0];
  const name = (student: Student) => t(`site.marketing.home.demo.students.${student}`);

  return (
    <div className="mk-demo-register" ref={rootRef}>
      <section className="mk-pane" aria-labelledby={`${baseId}-teacher`}>
        <header className="mk-pane__head">
          <span className="mk-pane__role">
            {t("site.marketing.home.demo.register.teacherRole")}
          </span>
          <h3 id={`${baseId}-teacher`} className="mk-pane__title">
            {t("site.marketing.home.demo.register.teacherPanel")}
          </h3>
        </header>
        <ul className="mk-register">
          {STUDENTS.map((student) => (
            <li key={student} className="mk-register__row" data-status={marks[student]}>
              <span className="mk-register__name">{name(student)}</span>
              <span className="mk-segmented" role="radiogroup" aria-label={name(student)}>
                {STATUSES.map((status) => (
                  <label key={status} className="mk-segmented__option" data-value={status}>
                    <input
                      type="radio"
                      name={`${baseId}-${student}`}
                      value={status}
                      checked={marks[student] === status}
                      onChange={() => {
                        setTouched(true);
                        mark(student, status);
                      }}
                    />
                    <span>{t(`site.marketing.home.demo.register.status.${status}`)}</span>
                  </label>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <button type="button" className="mk-text-button" onClick={reset}>
          {t("site.marketing.home.demo.register.reset")}
        </button>
      </section>

      <section className="mk-pane mk-pane--phone" aria-labelledby={`${baseId}-parent`}>
        <header className="mk-pane__head">
          <span className="mk-pane__role">{t("site.marketing.home.demo.register.parentRole")}</span>
          <h3 id={`${baseId}-parent`} className="mk-pane__title">
            {latest
              ? t("site.marketing.home.demo.register.parentPanel", { name: name(latest.student) })
              : t("site.marketing.home.demo.register.parentIdle")}
          </h3>
        </header>
        <div className="mk-phone">
          <div className="mk-phone__bar" aria-hidden="true">
            <span>9:41</span>
            <span className="mk-phone__notch" />
            <span>Studafy</span>
          </div>
          <ol className="mk-phone__list" aria-live="polite">
            {notices.length === 0 ? (
              <li className="mk-phone__empty">
                {t("site.marketing.home.demo.register.parentEmpty")}
              </li>
            ) : (
              notices.map((notice) => (
                <li key={notice.id} className="mk-notice" data-status={notice.status}>
                  <span className="mk-notice__app">Studafy</span>
                  <span className="mk-notice__body">
                    {t(`site.marketing.home.demo.register.notice.${notice.status}`, {
                      name: name(notice.student),
                    })}
                  </span>
                  <span className="mk-notice__time">
                    {t("site.marketing.home.demo.register.justNow")}
                  </span>
                </li>
              ))
            )}
          </ol>
        </div>
      </section>

      <section className="mk-pane" aria-labelledby={`${baseId}-office`}>
        <header className="mk-pane__head">
          <span className="mk-pane__role">{t("site.marketing.home.demo.register.officeRole")}</span>
          <h3 id={`${baseId}-office`} className="mk-pane__title">
            {t("site.marketing.home.demo.register.officePanel")}
          </h3>
        </header>
        <dl className="mk-counts">
          {counts.map(({ status, count }) => (
            <div key={status} className="mk-counts__item" data-status={status}>
              <dt>{t(`site.marketing.home.demo.register.status.${status}`)}</dt>
              <dd>
                <span className="mk-counts__number">{count}</span>
                <span
                  className="mk-counts__bar"
                  aria-hidden="true"
                  style={{ "--share": count / STUDENTS.length } as CSSProperties}
                />
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
