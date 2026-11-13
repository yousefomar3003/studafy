import { useId, useRef, useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import type { CSSProperties, KeyboardEvent } from "react";

import "./demos.css";

/** Each role, and where it works: MOBILE_ONLY_ROLES (packages/constants) use the phone app. */
const ROLES = [
  { id: "admin", where: "web" },
  { id: "principal", where: "web" },
  { id: "finance", where: "web" },
  { id: "teacher", where: "app" },
  { id: "attendance", where: "app" },
  { id: "parent", where: "app" },
  { id: "student", where: "app" },
] as const;

type RoleId = (typeof ROLES)[number]["id"];

const T = "marketingPages.demo.tour";

/**
 * "Every role sees its own part of the school", as a set of tabs: pick a role and see the screen
 * that role works in, with the three things they do. The screens are small working examples --
 * the principal can approve marks, finance can record a payment, the teacher can take a register,
 * the student can hand in homework -- so the page shows the product rather than describing it.
 * Example data only. Arrow keys, Home and End move between tabs (WAI-ARIA tabs pattern).
 */
export function RoleTour() {
  const { t } = useTranslation();
  const [active, setActive] = useState<RoleId>("admin");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const step: Record<string, number> = {
      ArrowRight: rtl ? -1 : 1,
      ArrowLeft: rtl ? 1 : -1,
      ArrowDown: 1,
      ArrowUp: -1,
    };
    let next: number | null = null;
    if (event.key in step) next = (index + step[event.key]! + ROLES.length) % ROLES.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = ROLES.length - 1;
    if (next === null) return;
    event.preventDefault();
    setActive(ROLES[next]!.id);
    tabRefs.current[next]?.focus();
  };

  const role = ROLES.find((candidate) => candidate.id === active)!;

  return (
    <div className="mk-tour">
      <div className="mk-tour__tabs" role="tablist" aria-label={t(`${T}.tablistLabel`)}>
        {ROLES.map((candidate, index) => (
          <button
            key={candidate.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${candidate.id}`}
            aria-selected={active === candidate.id}
            aria-controls={`${baseId}-panel`}
            tabIndex={active === candidate.id ? 0 : -1}
            className="mk-tour__tab"
            onClick={() => setActive(candidate.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <span className="mk-tour__tab-name">
              {t(`marketingPages.roles.${candidate.id}.name`)}
            </span>
            <span className="mk-tour__tab-where">
              {t(`marketingPages.where.${candidate.where}`)}
            </span>
          </button>
        ))}
      </div>

      <div
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${active}`}
        className="mk-tour__panel"
        key={active}
      >
        <div className="mk-tour__text">
          <h3 className="mk-tour__name">{t(`marketingPages.roles.${active}.name`)}</h3>
          <p className="mk-tour__where">
            {t(`${T}.where`, { where: t(`marketingPages.where.${role.where}`) })}
          </p>
          <ul className="mk-tour__does">
            {(["a", "b", "c"] as const).map((item) => (
              <li key={item}>{t(`marketingPages.roles.${active}.${item}`)}</li>
            ))}
          </ul>
        </div>
        <div className="mk-screen" data-device={role.where}>
          <RoleScreen role={active} />
        </div>
      </div>
    </div>
  );
}

function RoleScreen({ role }: { role: RoleId }) {
  switch (role) {
    case "admin":
      return <AdminScreen />;
    case "principal":
      return <PrincipalScreen />;
    case "finance":
      return <FinanceScreen />;
    case "teacher":
      return <TeacherScreen />;
    case "attendance":
      return <AttendanceScreen />;
    case "parent":
      return <ParentScreen />;
    case "student":
      return <StudentScreen />;
  }
}

function AdminScreen() {
  const { t } = useTranslation();
  const people = ["lina", "yousef", "sara"] as const;
  return (
    <>
      <p className="mk-screen__title">{t(`${T}.admin.title`)}</p>
      <ul className="mk-screen__list">
        {people.map((person) => (
          <li key={person} className="mk-screen__row">
            <span className="mk-avatar" aria-hidden="true">
              {t(`marketingPages.demo.students.${person}`).slice(0, 1)}
            </span>
            <span className="mk-screen__grow">{t(`marketingPages.demo.students.${person}`)}</span>
            <span className="mk-chip">{t(`${T}.admin.people.${person}`)}</span>
          </li>
        ))}
      </ul>
      <p className="mk-screen__title">{t(`${T}.admin.importTitle`)}</p>
      <div className="mk-progress" aria-hidden="true">
        <span style={{ "--share": 0.99 } as CSSProperties} />
      </div>
      <p className="mk-screen__meta">{t(`${T}.admin.importStatus`)}</p>
    </>
  );
}

function PrincipalScreen() {
  const { t } = useTranslation();
  const [approved, setApproved] = useState(false);
  return (
    <>
      <p className="mk-screen__title">{t(`${T}.principal.title`)}</p>
      <div className="mk-screen__card" data-done={approved}>
        <p className="mk-screen__strong">{t(`${T}.principal.item`)}</p>
        <p className="mk-screen__meta">{t(`${T}.principal.meta`)}</p>
        {approved ? (
          <p className="mk-done" role="status">
            {t(`${T}.principal.approved`)}
          </p>
        ) : (
          <button type="button" className="mk-mini-button" onClick={() => setApproved(true)}>
            {t(`${T}.principal.approve`)}
          </button>
        )}
      </div>
    </>
  );
}

function FinanceScreen() {
  const { t } = useTranslation();
  const { formatCurrency } = useFormatters();
  const [paid, setPaid] = useState(false);
  const invoices = [
    { family: "haddad", amount: 1200, status: "paid" },
    { family: "saleh", amount: 950, status: paid ? "paid" : "due" },
    { family: "amin", amount: 1200, status: "overdue" },
  ] as const;
  return (
    <>
      <p className="mk-screen__title">{t(`${T}.finance.title`)}</p>
      <ul className="mk-screen__list">
        {invoices.map((invoice) => (
          <li key={invoice.family} className="mk-screen__row">
            <span className="mk-screen__grow">{t(`${T}.finance.families.${invoice.family}`)}</span>
            <span className="mk-screen__number">
              {formatCurrency(invoice.amount, "JOD", { maximumFractionDigits: 0 })}
            </span>
            <span className="mk-chip" data-tone={invoice.status}>
              {t(`${T}.finance.status.${invoice.status}`)}
            </span>
          </li>
        ))}
      </ul>
      {paid ? null : (
        <button type="button" className="mk-mini-button" onClick={() => setPaid(true)}>
          {t(`${T}.finance.record`)} · {t(`${T}.finance.families.saleh`)}
        </button>
      )}
    </>
  );
}

function TeacherScreen() {
  const { t } = useTranslation();
  const [taken, setTaken] = useState(false);
  return (
    <>
      <p className="mk-screen__title">{t(`${T}.teacher.title`)}</p>
      <ul className="mk-screen__list">
        <li className="mk-screen__row">
          <span className="mk-period">{t(`${T}.period`, { number: 1 })}</span>
          <span className="mk-screen__grow">{t(`${T}.teacher.lessons.p1`)}</span>
          <span className="mk-done">{t(`${T}.teacher.taken`)}</span>
        </li>
        <li className="mk-screen__row" data-current="true">
          <span className="mk-period">{t(`${T}.period`, { number: 2 })}</span>
          <span className="mk-screen__grow">{t(`${T}.teacher.lessons.p2`)}</span>
          {taken ? (
            <span className="mk-done" role="status">
              {t(`${T}.teacher.taken`)}
            </span>
          ) : (
            <button type="button" className="mk-mini-button" onClick={() => setTaken(true)}>
              {t(`${T}.teacher.take`)}
            </button>
          )}
        </li>
        <li className="mk-screen__row">
          <span className="mk-period">{t(`${T}.period`, { number: 3 })}</span>
          <span className="mk-screen__grow">{t(`${T}.teacher.lessons.p3`)}</span>
          <span className="mk-screen__meta">{t(`${T}.teacher.later`)}</span>
        </li>
      </ul>
    </>
  );
}

function AttendanceScreen() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const grades = [
    ["g7", 0.97],
    ["g8", 0.93],
    ["g9", 0.95],
    ["g10", 0.91],
  ] as const;
  return (
    <>
      <p className="mk-screen__title">{t(`${T}.attendance.title`)}</p>
      <ul className="mk-screen__list">
        {grades.map(([grade, share]) => (
          <li key={grade} className="mk-screen__row mk-screen__row--bar">
            <span className="mk-screen__label">{t(`${T}.attendance.grades.${grade}`)}</span>
            <span className="mk-progress" aria-hidden="true">
              <span style={{ "--share": share } as CSSProperties} />
            </span>
            <span className="mk-screen__number">{formatNumber(share, { style: "percent" })}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function ParentScreen() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  return (
    <>
      <p className="mk-screen__title">{t(`${T}.parent.title`)}</p>
      <dl className="mk-facts-mini">
        <div>
          <dt>{t(`${T}.parent.attendance`)}</dt>
          <dd className="mk-screen__big">{formatNumber(0.96, { style: "percent" })}</dd>
        </div>
        <div>
          <dt>{t(`${T}.parent.homework`)}</dt>
          <dd>{t(`${T}.parent.homeworkValue`)}</dd>
        </div>
        <div>
          <dt>{t(`${T}.parent.mark`)}</dt>
          <dd>{t(`${T}.parent.markValue`)}</dd>
        </div>
      </dl>
    </>
  );
}

function StudentScreen() {
  const { t } = useTranslation();
  const [handedIn, setHandedIn] = useState(false);
  const periods = ["p1", "p2", "p3", "p4"] as const;
  return (
    <>
      <p className="mk-screen__title">{t(`${T}.student.title`)}</p>
      <ul className="mk-screen__list">
        {periods.map((period, index) => (
          <li
            key={period}
            className="mk-screen__row"
            data-current={period === "p2" ? "true" : undefined}
          >
            <span className="mk-period">{t(`${T}.period`, { number: index + 1 })}</span>
            <span className="mk-screen__grow">{t(`${T}.student.periods.${period}`)}</span>
            {period === "p2" ? <span className="mk-chip">{t(`${T}.student.now`)}</span> : null}
          </li>
        ))}
      </ul>
      <div className="mk-screen__card" data-done={handedIn}>
        <p className="mk-screen__strong">{t(`${T}.student.homework`)}</p>
        {handedIn ? (
          <p className="mk-done" role="status">
            {t(`${T}.student.handedIn`)}
          </p>
        ) : (
          <button type="button" className="mk-mini-button" onClick={() => setHandedIn(true)}>
            {t(`${T}.student.handIn`)}
          </button>
        )}
      </div>
    </>
  );
}
