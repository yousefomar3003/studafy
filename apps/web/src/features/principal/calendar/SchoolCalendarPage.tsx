import { PERMISSIONS } from "@studafy/constants";
import { Button } from "@studafy/ui";
import { useState } from "react";

import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import {
  todayIso,
  useAcademicYears,
  useClassesForTerms,
  useExamsForClasses,
  useSchoolEvents,
  useTermsForYears,
} from "../school/queries";

import { EventFormModal } from "./EventFormModal";

import type { SchoolEvent } from "../school/queries";

import "../school/principal-school.css";
import "./calendar.css";

/** What a calendar cell can hold. `tone` picks the colour; `event` is set for editable entries. */
export interface CalendarEntry {
  key: string;
  date: string;
  label: string;
  tone: "term" | "exam" | SchoolEvent["kind"];
  event?: SchoolEvent;
}

const DAY_MS = 86_400_000;
const WEEKS = 6;

function iso(date: Date): string {
  return todayIso(date);
}

function parseIso(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

function addDays(value: string, days: number): string {
  return iso(new Date(parseIso(value).getTime() + days * DAY_MS + DAY_MS / 2));
}

/** The 6×7 grid around `month` (any date in it), starting on the Sunday on or before the 1st. */
export function monthGrid(month: Date): string[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = iso(new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay()));
  return Array.from({ length: WEEKS * 7 }, (_, index) => addDays(start, index));
}

/** Every day from `from` to `to`, inclusive, clipped to [windowStart, windowEnd]. */
function daysInRange(from: string, to: string, windowStart: string, windowEnd: string): string[] {
  const days: string[] = [];
  let day = from < windowStart ? windowStart : from;
  const last = to > windowEnd ? windowEnd : to;
  while (day <= last) {
    days.push(day);
    day = addDays(day, 1);
  }
  return days;
}

/**
 * School calendar (`/portal/principal/calendar`): one month of the school year on a grid — term
 * start and end dates, every class's exams, and the school's own holidays, events, meetings and exam
 * periods. Holders of `calendarEvent:manage` (principal, admin) add entries with "Add event" or by
 * picking a day, and edit or remove one by choosing it. The same entries are listed below the grid
 * in date order, which is also how a screen reader or a narrow screen reads the month.
 */
export default function SchoolCalendarPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const canManage = usePermissions().has(PERMISSIONS.CALENDAR_EVENT_MANAGE);
  const today = todayIso();

  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [form, setForm] = useState<{ event?: SchoolEvent; date: string; key: number }>();

  const grid = monthGrid(month);
  const windowStart = grid[0]!;
  const windowEnd = grid.at(-1)!;

  const years = useAcademicYears();
  const yearIds = (years.data ?? [])
    .filter((year) => year.starts_on <= windowEnd && year.ends_on >= windowStart)
    .map((year) => year.id);
  const terms = useTermsForYears(yearIds);
  const visibleTerms = terms.filter(
    (term) => term.starts_on <= windowEnd && term.ends_on >= windowStart,
  );
  const classes = useClassesForTerms(visibleTerms.map((term) => term.id));
  const exams = useExamsForClasses(classes);
  const events = useSchoolEvents(windowStart, windowEnd);

  const classCode = new Map(classes.map((klass) => [klass.id, klass.code]));
  const entries: CalendarEntry[] = [];
  for (const term of visibleTerms) {
    if (term.starts_on >= windowStart && term.starts_on <= windowEnd) {
      entries.push({
        key: `term-start-${term.id}`,
        date: term.starts_on,
        label: t("principal.calendar.termStarts", { term: term.name }),
        tone: "term",
      });
    }
    if (term.ends_on >= windowStart && term.ends_on <= windowEnd) {
      entries.push({
        key: `term-end-${term.id}`,
        date: term.ends_on,
        label: t("principal.calendar.termEnds", { term: term.name }),
        tone: "term",
      });
    }
  }
  for (const exam of exams.exams) {
    const date = iso(new Date(exam.starts_at));
    if (date < windowStart || date > windowEnd) continue;
    entries.push({
      key: `exam-${exam.id}`,
      date,
      label: t("principal.calendar.exam", {
        title: exam.title,
        class: classCode.get(exam.class_id) ?? "",
      }),
      tone: "exam",
    });
  }
  for (const event of events.data ?? []) {
    for (const date of daysInRange(event.starts_on, event.ends_on, windowStart, windowEnd)) {
      entries.push({
        key: `event-${event.id}-${date}`,
        date,
        label: event.title,
        tone: event.kind,
        event,
      });
    }
  }

  const byDate = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    byDate.set(entry.date, [...(byDate.get(entry.date) ?? []), entry]);
  }

  const monthPrefix = iso(month).slice(0, 7);
  const agenda = entries
    .filter((entry) => entry.date.startsWith(monthPrefix))
    // A multi-day event is listed once, on its first day in this month.
    .filter(
      (entry, index, all) =>
        !entry.event || all.findIndex((other) => other.event?.id === entry.event?.id) === index,
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));

  const openForm = (date: string, event?: SchoolEvent) =>
    setForm({ date, ...(event ? { event } : {}), key: Date.now() });
  const shiftMonth = (delta: number) =>
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  const weekdays = grid.slice(0, 7).map((day) => formatDate(parseIso(day), { weekday: "short" }));
  const loadFailed = events.isError;

  return (
    <>
      <h1>{t("principal.calendar.title")}</h1>
      <p>{t("principal.calendar.description")}</p>

      <div className="principal-calendar__toolbar">
        <div className="principal-calendar__nav">
          <Button type="button" variant="tertiary" onClick={() => shiftMonth(-1)}>
            {t("principal.calendar.previous")}
          </Button>
          <h2 className="principal-calendar__month" aria-live="polite">
            {formatDate(month, { month: "long", year: "numeric" })}
          </h2>
          <Button type="button" variant="tertiary" onClick={() => shiftMonth(1)}>
            {t("principal.calendar.next")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              const now = new Date();
              setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
            }}
          >
            {t("principal.calendar.today")}
          </Button>
        </div>
        {canManage ? (
          <Button type="button" variant="primary" onClick={() => openForm(today)}>
            {t("principal.calendar.addEvent")}
          </Button>
        ) : null}
      </div>

      <ul className="principal-calendar__legend" aria-label={t("principal.calendar.legend")}>
        {(["term", "exam", "holiday", "event", "meeting", "exam_period"] as const).map((tone) => (
          <li key={tone} data-tone={tone}>
            {t(`principal.calendar.kinds.${tone}`)}
          </li>
        ))}
      </ul>

      {loadFailed ? <p role="alert">{t("principal.calendar.error")}</p> : null}

      <div className="principal-calendar__grid" aria-hidden="true">
        {weekdays.map((weekday) => (
          <div key={weekday} className="principal-calendar__weekday">
            {weekday}
          </div>
        ))}
        {grid.map((day) => {
          const outside = !day.startsWith(monthPrefix);
          return (
            <div
              key={day}
              className="principal-calendar__day"
              data-outside={outside || undefined}
              data-today={day === today || undefined}
            >
              {canManage ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className="principal-calendar__date principal-calendar__date--action"
                  onClick={() => openForm(day)}
                >
                  {parseIso(day).getDate()}
                </button>
              ) : (
                <span className="principal-calendar__date">{parseIso(day).getDate()}</span>
              )}
              {(byDate.get(day) ?? []).map((entry) =>
                entry.event && canManage ? (
                  <button
                    key={entry.key}
                    type="button"
                    tabIndex={-1}
                    className="principal-calendar__entry"
                    data-tone={entry.tone}
                    title={entry.label}
                    onClick={() => openForm(day, entry.event)}
                  >
                    {entry.label}
                  </button>
                ) : (
                  <span
                    key={entry.key}
                    className="principal-calendar__entry"
                    data-tone={entry.tone}
                    title={entry.label}
                  >
                    {entry.label}
                  </span>
                ),
              )}
            </div>
          );
        })}
      </div>

      <h2 className="principal-calendar__agenda-title">{t("principal.calendar.agenda")}</h2>
      {agenda.length === 0 ? (
        <p className="principal-school__empty">{t("principal.calendar.agendaEmpty")}</p>
      ) : (
        <ul className="principal-calendar__agenda">
          {agenda.map((entry) => {
            const span =
              entry.event && entry.event.ends_on !== entry.event.starts_on
                ? `${formatDate(parseIso(entry.event.starts_on), { dateStyle: "medium" })} – ${formatDate(parseIso(entry.event.ends_on), { dateStyle: "medium" })}`
                : formatDate(parseIso(entry.date), {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                  });
            return (
              <li key={entry.key} data-tone={entry.tone}>
                <span className="principal-calendar__agenda-date">{span}</span>
                <span className="principal-calendar__agenda-kind">
                  {t(`principal.calendar.kinds.${entry.tone}`)}
                </span>
                {entry.event && canManage ? (
                  <button
                    type="button"
                    className="principal-calendar__agenda-edit"
                    onClick={() => openForm(entry.date, entry.event)}
                  >
                    {entry.label}
                  </button>
                ) : (
                  <span>{entry.label}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {form ? (
        <EventFormModal
          key={form.key}
          open
          onClose={() => setForm(undefined)}
          defaultDate={form.date}
          {...(form.event ? { event: form.event } : {})}
        />
      ) : null}
    </>
  );
}
