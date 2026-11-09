import { useId, useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import type { ComponentType, CSSProperties } from "react";

import "./demos.css";

/**
 * One small working example per area of the features page, beside its description: each does the
 * thing the area is about (places a lesson, corrects a register, weighs a term mark), so the page
 * shows the product instead of listing it. Example data only; nothing is sent anywhere.
 */

const F = "marketingPages.features.demos";

// --- Academics: place a lesson in the first free slot --------------------------------------------

const DAYS = ["sun", "mon", "tue", "wed", "thu"] as const;
const PERIODS = 4;
type Subject = "maths" | "science" | "arabic" | "english" | "pe";

/** Grade 8B's week: rows are periods, columns days. Null is a free slot. */
const WEEK: (Subject | null)[][] = [
  ["maths", "arabic", "maths", "english", "science"],
  ["english", "maths", null, "arabic", "maths"],
  ["arabic", null, "english", "maths", null],
  ["pe", "science", "arabic", null, "english"],
];

function AcademicsDemo() {
  const { t } = useTranslation();
  const [placed, setPlaced] = useState<[number, number][]>([]);
  const isPlaced = (period: number, day: number) =>
    placed.some(([p, d]) => p === period && d === day);
  const free: [number, number][] = [];
  for (let day = 0; day < DAYS.length; day += 1) {
    for (let period = 0; period < PERIODS; period += 1) {
      if (WEEK[period]![day] === null && !isPlaced(period, day)) free.push([period, day]);
    }
  }
  const last = placed.at(-1);

  return (
    <div className="mk-mini">
      <table className="mk-timetable">
        <caption className="mk-mini__caption">{t(`${F}.academics.caption`)}</caption>
        <thead>
          <tr>
            <td />
            {DAYS.map((day) => (
              <th key={day} scope="col">
                {t(`${F}.academics.days.${day}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WEEK.map((row, period) => (
            <tr key={period}>
              <th scope="row">{period + 1}</th>
              {row.map((subject, day) => {
                const added = isPlaced(period, day);
                const shown = added ? "science" : subject;
                return (
                  <td key={day} data-subject={shown ?? undefined} data-new={added || undefined}>
                    {shown ? t(`${F}.academics.subjects.${shown}`) : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mk-mini__actions">
        <button
          type="button"
          className="mk-mini-button"
          disabled={free.length === 0}
          onClick={() => setPlaced((current) => [...current, free[0]!])}
        >
          {t(`${F}.academics.place`)}
        </button>
      </div>
      <p className="mk-mini__status" role="status">
        {free.length === 0 && placed.length > 0
          ? t(`${F}.academics.full`)
          : last
            ? t(`${F}.academics.placed`, {
                day: t(`${F}.academics.days.${DAYS[last[1]]}`),
                period: last[0] + 1,
              })
            : ""}
      </p>
    </div>
  );
}

// --- Attendance: correct a mark, with a reason, leaving a history line ---------------------------

const ATTENDANCE_STATUSES = ["present", "late", "absent"] as const;
const REASONS = ["bus", "doctor", "mistake"] as const;
type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

function AttendanceDemo() {
  const { t } = useTranslation();
  const id = useId();
  const [status, setStatus] = useState<AttendanceStatus>("absent");
  const [editing, setEditing] = useState(false);
  const [next, setNext] = useState<AttendanceStatus>("late");
  const [reason, setReason] = useState<(typeof REASONS)[number]>("bus");
  const [history, setHistory] = useState<string[]>([]);
  const label = (value: AttendanceStatus) => t(`marketingPages.demo.register.status.${value}`);

  return (
    <div className="mk-mini">
      <div className="mk-mini__row">
        <span className="mk-mini__strong">{t(`${F}.attendance.student`)}</span>
        <span
          className="mk-chip"
          data-tone={status === "present" ? "paid" : status === "late" ? "due" : "overdue"}
        >
          {label(status)}
        </span>
      </div>
      {editing ? (
        <div className="mk-mini__form">
          <label htmlFor={`${id}-status`}>{t(`${F}.attendance.newStatus`)}</label>
          <select
            id={`${id}-status`}
            value={next}
            onChange={(event) => setNext(event.target.value as AttendanceStatus)}
          >
            {ATTENDANCE_STATUSES.filter((value) => value !== status).map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-reason`}>{t(`${F}.attendance.reason`)}</label>
          <select
            id={`${id}-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value as (typeof REASONS)[number])}
          >
            {REASONS.map((value) => (
              <option key={value} value={value}>
                {t(`${F}.attendance.reasons.${value}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="mk-mini-button"
            onClick={() => {
              setHistory((current) => [
                t(`${F}.attendance.history`, {
                  from: label(status),
                  to: label(next),
                  reason: t(`${F}.attendance.reasons.${reason}`),
                }),
                ...current,
              ]);
              setStatus(next);
              setNext(ATTENDANCE_STATUSES.find((value) => value !== next)!);
              setEditing(false);
            }}
          >
            {t(`${F}.attendance.save`)}
          </button>
        </div>
      ) : (
        <div className="mk-mini__actions">
          <button type="button" className="mk-mini-button" onClick={() => setEditing(true)}>
            {t(`${F}.attendance.correct`)}
          </button>
        </div>
      )}
      <ol className="mk-mini__log" aria-live="polite">
        {history.length === 0 ? (
          <li className="mk-screen__meta">{t(`${F}.attendance.noHistory`)}</li>
        ) : (
          history.map((entry, index) => <li key={history.length - index}>{entry}</li>)
        )}
      </ol>
    </div>
  );
}

// --- Homework: mark what was handed in ------------------------------------------------------------

const HOMEWORK_TOTAL = 26;
const HOMEWORK_ROWS = [
  { student: "omar", handedIn: true },
  { student: "lina", handedIn: true },
  { student: "yousef", handedIn: false },
  { student: "sara", handedIn: true },
] as const;

function HomeworkDemo() {
  const { t } = useTranslation();
  const [scores, setScores] = useState<Record<string, number>>({});
  const handedIn = 18;
  const name = (student: string) => t(`marketingPages.demo.students.${student}`);

  return (
    <div className="mk-mini">
      <p className="mk-mini__strong">{t(`${F}.homework.title`)}</p>
      <div className="mk-progress" aria-hidden="true">
        <span style={{ "--share": handedIn / HOMEWORK_TOTAL } as CSSProperties} />
      </div>
      <p className="mk-screen__meta">
        {t(`${F}.homework.handedIn`, { count: handedIn, total: HOMEWORK_TOTAL })}
      </p>
      <ul className="mk-screen__list">
        {HOMEWORK_ROWS.map(({ student, handedIn: done }) => (
          <li key={student} className="mk-screen__row">
            <span className="mk-screen__grow">{name(student)}</span>
            {!done ? (
              <span className="mk-screen__meta">{t(`${F}.homework.missing`)}</span>
            ) : scores[student] !== undefined ? (
              <span className="mk-done">
                {t(`${F}.homework.marked`, { score: scores[student] })}
              </span>
            ) : (
              <select
                aria-label={t(`${F}.homework.score`, { name: name(student) })}
                className="mk-mini__select"
                defaultValue=""
                onChange={(event) =>
                  setScores((current) => ({ ...current, [student]: Number(event.target.value) }))
                }
              >
                <option value="" disabled>
                  {t(`${F}.homework.mark`)}
                </option>
                {Array.from({ length: 11 }, (_, score) => (
                  <option key={score} value={score}>
                    {score}
                  </option>
                ))}
              </select>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Exams and marks: the school's own weights make the term mark ---------------------------------

const PARTS = [
  { id: "coursework", score: 88, weight: 30 },
  { id: "midterm", score: 74, weight: 30 },
  { id: "final", score: 81, weight: 40 },
] as const;

function ExamsDemo() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const id = useId();
  const [weights, setWeights] = useState<number[]>(PARTS.map((part) => part.weight));
  const sum = weights.reduce((total, weight) => total + weight, 0);
  const mark = PARTS.reduce(
    (total, part, index) => total + (part.score * weights[index]!) / 100,
    0,
  );

  return (
    <div className="mk-mini">
      <p className="mk-mini__strong">{t(`${F}.exams.title`)}</p>
      {PARTS.map((part, index) => (
        <div key={part.id} className="mk-weight">
          <label htmlFor={`${id}-${part.id}`} className="mk-weight__label">
            <span>{t(`${F}.exams.parts.${part.id}`)}</span>
            <span className="mk-screen__meta">{t(`${F}.exams.score`, { score: part.score })}</span>
          </label>
          <input
            id={`${id}-${part.id}`}
            type="range"
            min={0}
            max={100}
            step={5}
            value={weights[index]}
            aria-valuetext={`${weights[index]}%`}
            onChange={(event) =>
              setWeights((current) =>
                current.map((weight, at) => (at === index ? Number(event.target.value) : weight)),
              )
            }
          />
          <span className="mk-weight__value">{weights[index]}%</span>
        </div>
      ))}
      <div className="mk-mini__total" data-invalid={sum !== 100 || undefined}>
        <span>{t(`${F}.exams.termMark`)}</span>
        <output
          className="mk-mini__big"
          htmlFor={PARTS.map((part) => `${id}-${part.id}`).join(" ")}
        >
          {sum === 100 ? formatNumber(mark, { maximumFractionDigits: 1 }) : "—"}
        </output>
      </div>
      {sum !== 100 ? (
        <p className="mk-mini__warning" role="status">
          {t(`${F}.exams.sum`, { sum })}
        </p>
      ) : null}
    </div>
  );
}

// --- Fees: a year's tuition split into instalments, with or without VAT ---------------------------

const TUITION = 1800;
const DUE_DATES = ["2026-09-01", "2026-11-01", "2027-01-01", "2027-03-01"];

function FinanceDemo() {
  const { t } = useTranslation();
  const { formatCurrency, formatDate } = useFormatters();
  const [count, setCount] = useState(2);
  const [vat, setVat] = useState(false);
  const total = vat ? TUITION * 1.16 : TUITION;
  const money = (value: number) => formatCurrency(value, "JOD", { maximumFractionDigits: 0 });

  return (
    <div className="mk-mini">
      <p className="mk-mini__strong">{t(`${F}.finance.title`)}</p>
      <div className="mk-mini__row">
        <span className="mk-screen__meta">{t(`${F}.finance.instalments`)}</span>
        <div className="mk-pills" role="group" aria-label={t(`${F}.finance.instalments`)}>
          {[1, 2, 3, 4].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={count === value}
              onClick={() => setCount(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      <label className="mk-mini__check">
        <input type="checkbox" checked={vat} onChange={(event) => setVat(event.target.checked)} />
        {t(`${F}.finance.vat`)}
      </label>
      <ul className="mk-screen__list">
        {DUE_DATES.slice(0, count).map((date) => (
          <li key={`${count}-${date}`} className="mk-screen__row mk-mini__arrive">
            <span className="mk-screen__grow">
              {t(`${F}.finance.due`, {
                date: formatDate(new Date(`${date}T00:00:00Z`), {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                  timeZone: "UTC",
                }),
              })}
            </span>
            <span className="mk-screen__number">{money(total / count)}</span>
          </li>
        ))}
      </ul>
      <div className="mk-mini__total">
        <span>{t(`${F}.finance.total`)}</span>
        <span className="mk-mini__big">{money(total)}</span>
      </div>
    </div>
  );
}

// --- Families: one account, each child ------------------------------------------------------------

function FamiliesDemo() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const [child, setChild] = useState<"omar" | "lina">("omar");
  const attendance = { omar: 0.96, lina: 0.99 };

  return (
    <div className="mk-mini">
      <p className="mk-mini__strong">{t(`${F}.families.title`)}</p>
      <div className="mk-pills mk-pills--wide" role="group" aria-label={t(`${F}.families.title`)}>
        {(["omar", "lina"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={child === value}
            onClick={() => setChild(value)}
          >
            {t(`${F}.families.children.${value}`)}
          </button>
        ))}
      </div>
      <dl className="mk-facts-mini mk-mini__arrive" key={child}>
        <div>
          <dt>{t(`${F}.families.attendance`)}</dt>
          <dd className="mk-mini__big">{formatNumber(attendance[child], { style: "percent" })}</dd>
        </div>
        <div>
          <dt>{t(`${F}.families.next`)}</dt>
          <dd>{t(`${F}.families.nextValue.${child}`)}</dd>
        </div>
      </dl>
      <div className="mk-mini__total">
        <span>{t(`${F}.families.balance`)}</span>
        <span>{t(`${F}.families.balanceValue`)}</span>
      </div>
    </div>
  );
}

// --- Announcements: who it reaches, and when ------------------------------------------------------

const AUDIENCES = { school: 640, parents: 410, class: 26 } as const;
type Audience = keyof typeof AUDIENCES;

function AnnouncementsDemo() {
  const { t } = useTranslation();
  const [audience, setAudience] = useState<Audience>("parents");
  const [when, setWhen] = useState<"now" | "later">("later");
  const [done, setDone] = useState<string | null>(null);
  const reach = AUDIENCES[audience];
  const reset = () => setDone(null);

  return (
    <div className="mk-mini">
      <p className="mk-mini__strong">{t(`${F}.announcements.title`)}</p>
      <fieldset className="mk-mini__fieldset">
        <legend className="mk-screen__meta">{t(`${F}.announcements.audience`)}</legend>
        <div className="mk-pills mk-pills--wide">
          {(Object.keys(AUDIENCES) as Audience[]).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={audience === value}
              onClick={() => {
                setAudience(value);
                reset();
              }}
            >
              {t(`${F}.announcements.audiences.${value}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="mk-mini__fieldset">
        <legend className="mk-screen__meta">{t(`${F}.announcements.when`)}</legend>
        <div className="mk-pills mk-pills--wide">
          {(["now", "later"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={when === value}
              onClick={() => {
                setWhen(value);
                reset();
              }}
            >
              {t(`${F}.announcements.times.${value}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="mk-mini__row">
        <span className="mk-mini__strong">{t(`${F}.announcements.reach`, { count: reach })}</span>
        <button
          type="button"
          className="mk-mini-button"
          onClick={() =>
            setDone(
              t(`${F}.announcements.${when === "now" ? "sent" : "scheduled"}`, { count: reach }),
            )
          }
        >
          {t(`${F}.announcements.${when === "now" ? "send" : "schedule"}`)}
        </button>
      </div>
      <p className="mk-mini__status" role="status">
        {done ? <span className="mk-done">{done}</span> : null}
      </p>
    </div>
  );
}

// --- Discipline: the actions taken, on the record -------------------------------------------------

const ACTIONS = ["note", "meeting", "plan"] as const;

function DisciplineDemo() {
  const { t } = useTranslation();
  const id = useId();
  const [action, setAction] = useState<(typeof ACTIONS)[number]>("note");
  const [log, setLog] = useState<string[]>([]);

  return (
    <div className="mk-mini">
      <p className="mk-mini__strong">{t(`${F}.discipline.incident`)}</p>
      <div className="mk-mini__form mk-mini__form--inline">
        <label htmlFor={`${id}-action`}>{t(`${F}.discipline.action`)}</label>
        <select
          id={`${id}-action`}
          value={action}
          onChange={(event) => setAction(event.target.value as (typeof ACTIONS)[number])}
        >
          {ACTIONS.map((value) => (
            <option key={value} value={value}>
              {t(`${F}.discipline.actions.${value}`)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="mk-mini-button"
          onClick={() =>
            setLog((current) => [
              t(`${F}.discipline.logged`, { action: t(`${F}.discipline.actions.${action}`) }),
              ...current,
            ])
          }
        >
          {t(`${F}.discipline.add`)}
        </button>
      </div>
      <ol className="mk-mini__log mk-mini__log--timeline" aria-live="polite">
        {log.length === 0 ? (
          <li className="mk-screen__meta">{t(`${F}.discipline.none`)}</li>
        ) : (
          log.map((entry, index) => <li key={log.length - index}>{entry}</li>)
        )}
      </ol>
    </div>
  );
}

// --- School records: build a field, and see it as staff will --------------------------------------

const FIELD_TYPES = ["short_text", "date", "yes_no", "number"] as const;

function RecordsDemo() {
  const { t } = useTranslation();
  const id = useId();
  const [label, setLabel] = useState(() => t(`${F}.records.labelDefault`));
  const [type, setType] = useState<(typeof FIELD_TYPES)[number]>("short_text");
  const [sensitive, setSensitive] = useState(false);

  return (
    <div className="mk-mini">
      <div className="mk-mini__form">
        <label htmlFor={`${id}-label`}>{t(`${F}.records.label`)}</label>
        <input
          id={`${id}-label`}
          value={label}
          maxLength={40}
          onChange={(event) => setLabel(event.target.value)}
        />
        <label htmlFor={`${id}-type`}>{t(`${F}.records.type`)}</label>
        <select
          id={`${id}-type`}
          value={type}
          onChange={(event) => setType(event.target.value as (typeof FIELD_TYPES)[number])}
        >
          {FIELD_TYPES.map((value) => (
            <option key={value} value={value}>
              {t(`${F}.records.types.${value}`)}
            </option>
          ))}
        </select>
      </div>
      <label className="mk-mini__check">
        <input
          type="checkbox"
          checked={sensitive}
          onChange={(event) => setSensitive(event.target.checked)}
        />
        {t(`${F}.records.sensitive`)}
      </label>
      <p className="mk-screen__title">{t(`${F}.records.preview`)}</p>
      <div className="mk-mini__preview" data-sensitive={sensitive || undefined}>
        <span className="mk-mini__preview-label">{label.trim() || "—"}</span>
        <span className="mk-mini__preview-value">
          {sensitive ? "••••" : t(`${F}.records.sampleValues.${type}`)}
        </span>
        {sensitive ? <span className="mk-screen__meta">{t(`${F}.records.masked`)}</span> : null}
      </div>
    </div>
  );
}

// --- Imports: match the spreadsheet's columns ------------------------------------------------------

const COLUMNS = ["name", "admission", "class", "bus"] as const;

function ImportsDemo() {
  const { t } = useTranslation();
  const [kept, setKept] = useState(false);

  return (
    <div className="mk-mini">
      <p className="mk-mini__strong">{t(`${F}.imports.file`)}</p>
      <ul className="mk-screen__list">
        {COLUMNS.map((column) => (
          <li key={column} className="mk-screen__row mk-match">
            <span className="mk-match__from">{t(`${F}.imports.columns.${column}`)}</span>
            <span className="mk-match__arrow" aria-hidden="true">
              →
            </span>
            {column !== "bus" ? (
              <span className="mk-done">{t(`${F}.imports.fields.${column}`)}</span>
            ) : kept ? (
              <span className="mk-done" role="status">
                {t(`${F}.imports.kept`)}
              </span>
            ) : (
              <span className="mk-match__open">
                <span className="mk-screen__meta">{t(`${F}.imports.notAField`)}</span>
                <button type="button" className="mk-mini-button" onClick={() => setKept(true)}>
                  {t(`${F}.imports.keep`)}
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Approvals and audit: sign off a change, see it logged ----------------------------------------

function OversightDemo() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const [decision, setDecision] = useState<{ kind: "approved" | "rejected"; at: Date } | null>(
    null,
  );

  return (
    <div className="mk-mini">
      <div className="mk-screen__card" data-done={decision?.kind === "approved" || undefined}>
        <p className="mk-screen__strong">{t(`${F}.oversight.change`)}</p>
        <p className="mk-screen__meta">{t(`${F}.oversight.by`)}</p>
        {decision ? null : (
          <div className="mk-mini__actions">
            <button
              type="button"
              className="mk-mini-button"
              onClick={() => setDecision({ kind: "approved", at: new Date() })}
            >
              {t(`${F}.oversight.approve`)}
            </button>
            <button
              type="button"
              className="mk-text-button"
              onClick={() => setDecision({ kind: "rejected", at: new Date() })}
            >
              {t(`${F}.oversight.reject`)}
            </button>
          </div>
        )}
      </div>
      <p className="mk-screen__title">{t(`${F}.oversight.audit`)}</p>
      <ol className="mk-mini__log" aria-live="polite">
        {decision ? (
          <li>
            {t(`${F}.oversight.${decision.kind}`, {
              time: formatDate(decision.at, { hour: "2-digit", minute: "2-digit" }),
            })}
          </li>
        ) : (
          <li className="mk-screen__meta">{t(`${F}.oversight.empty`)}</li>
        )}
      </ol>
    </div>
  );
}

export const FEATURE_DEMOS: Readonly<Record<string, ComponentType>> = {
  academics: AcademicsDemo,
  attendance: AttendanceDemo,
  homework: HomeworkDemo,
  exams: ExamsDemo,
  finance: FinanceDemo,
  families: FamiliesDemo,
  announcements: AnnouncementsDemo,
  discipline: DisciplineDemo,
  records: RecordsDemo,
  imports: ImportsDemo,
  oversight: OversightDemo,
};
