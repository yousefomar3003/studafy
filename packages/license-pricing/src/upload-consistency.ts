/**
 * Upload consistency for the Student AI programme's content bonus (decision 10 of
 * AI-REVSHARE-PLAN.md): the percentage of school days on which a class's teachers published a lesson
 * or material, averaged across the classes that have Student AI.
 *
 * Pure: the caller reads the school's calendar and the days each class published on (in the
 * school's own timezone) and this module does the counting. No clock either: "today" is an input,
 * so the same inputs always give the same answer and the revenue share engine can recompute a past
 * period exactly.
 *
 * Dates are calendar days, `YYYY-MM-DD`, in the school's timezone. Every range is inclusive.
 *
 * Rounding is always down (never award a bonus tier that was not reached): a class's percentage is
 * floor(upload days x 10000 / school days) in basis points, and a teacher's or the school's is the
 * floor of the mean of their classes' basis points.
 */

import { tierFor } from "./ai-programme";

import type { AiProgrammeTier } from "./ai-programme";

/** An inclusive range of calendar days. */
export interface DayRange {
  startsOn: string;
  endsOn: string;
}

export interface UploadConsistencyClassInput {
  classId: string;
  /** The class's term: only its days count for it. */
  term: DayRange;
  /** Days (school timezone) on which at least one of the class's lessons or materials was published. */
  uploadDates: readonly string[];
  /** The class's teachers: its lead teacher and anyone teaching it on the timetable. */
  teacherIds: readonly string[];
}

export interface UploadConsistencyInput {
  /** The period measured, inclusive. */
  from: string;
  to: string;
  /** Today in the school's timezone: later days have not happened yet and never count. */
  today: string;
  /** The school's teaching weekdays, ISO numbering (1 = Monday .. 7 = Sunday). */
  schoolWeekdays: readonly number[];
  /** Calendar holidays, inclusive ranges. */
  holidays: readonly DayRange[];
  classes: readonly UploadConsistencyClassInput[];
}

export interface UploadConsistencyClassResult {
  classId: string;
  /** School days in the period that fall in the class's term, up to today. */
  schoolDays: number;
  /** Of those, the days the class published something on. */
  uploadDays: number;
  /** uploadDays / schoolDays in basis points, rounded down; null when it had no school day. */
  consistencyBps: number | null;
}

export interface UploadConsistencyTeacherResult {
  teacherId: string;
  /** Every measured class the teacher teaches, including ones with no school day in the period. */
  classIds: string[];
  /** Mean of those classes' basis points (classes with a school day only), rounded down; null if none. */
  consistencyBps: number | null;
}

export interface UploadConsistencyResult {
  from: string;
  /** The last day counted: `to`, or today when `to` is later. Before `from` when nothing has happened yet. */
  countedTo: string;
  /** School days in [from, countedTo]: teaching weekdays that are not holidays. */
  schoolDays: number;
  /** Classes with at least one school day in the period: the ones the average is over. */
  classesCounted: number;
  /** Mean of the counted classes' basis points, rounded down; null when no class has a school day. */
  consistencyBps: number | null;
  classes: UploadConsistencyClassResult[];
  teachers: UploadConsistencyTeacherResult[];
}

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(date: string): number {
  if (!DATE_PATTERN.test(date)) throw new RangeError(`Not a calendar day: ${date}`);
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new RangeError(`Not a calendar day: ${date}`);
  }
  return ms / DAY_MS;
}

function dateOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** ISO weekday of a day number (1970-01-01, day 0, was a Thursday). */
function isoWeekday(day: number): number {
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

const minDate = (a: string, b: string) => (a <= b ? a : b);
const maxDate = (a: string, b: string) => (a >= b ? a : b);

/** Whole days from `from` to `to`, inclusive (0 when `to` is before `from`). */
export function daysInRange(from: string, to: string): number {
  return Math.max(0, dayNumber(to) - dayNumber(from) + 1);
}

/** The day after `date`. */
export function nextDay(date: string): string {
  return dateOf(dayNumber(date) + 1);
}

/**
 * The school days in [from, to]: the school's teaching weekdays, minus every day a holiday covers.
 * Ascending; empty when `to` is before `from`.
 */
export function schoolDaysBetween(
  from: string,
  to: string,
  schoolWeekdays: readonly number[],
  holidays: readonly DayRange[],
): string[] {
  const weekdays = new Set(schoolWeekdays);
  const off = holidays.map((h) => [dayNumber(h.startsOn), dayNumber(h.endsOn)] as const);
  const days: string[] = [];
  for (let day = dayNumber(from), last = dayNumber(to); day <= last; day += 1) {
    if (!weekdays.has(isoWeekday(day))) continue;
    if (off.some(([start, end]) => day >= start && day <= end)) continue;
    days.push(dateOf(day));
  }
  return days;
}

const floorMean = (values: readonly number[]) =>
  values.length === 0 ? null : Math.floor(values.reduce((sum, v) => sum + v, 0) / values.length);

/** Count school days and upload days per class, then average per teacher and for the school. */
export function computeUploadConsistency(input: UploadConsistencyInput): UploadConsistencyResult {
  dayNumber(input.from);
  dayNumber(input.to);
  const countedTo = minDate(input.to, input.today);
  const schoolDays = schoolDaysBetween(input.from, countedTo, input.schoolWeekdays, input.holidays);

  const classes = input.classes.map((klass): UploadConsistencyClassResult => {
    const start = maxDate(input.from, klass.term.startsOn);
    const end = minDate(countedTo, klass.term.endsOn);
    const days = schoolDays.filter((day) => day >= start && day <= end);
    const uploads = new Set(klass.uploadDates);
    const uploadDays = days.filter((day) => uploads.has(day)).length;
    return {
      classId: klass.classId,
      schoolDays: days.length,
      uploadDays,
      consistencyBps: days.length === 0 ? null : Math.floor((uploadDays * 10_000) / days.length),
    };
  });

  const byClass = new Map(classes.map((c) => [c.classId, c]));
  const teacherClasses = new Map<string, string[]>();
  for (const klass of input.classes) {
    for (const teacherId of new Set(klass.teacherIds)) {
      const list = teacherClasses.get(teacherId) ?? [];
      list.push(klass.classId);
      teacherClasses.set(teacherId, list);
    }
  }
  const counted = (ids: readonly string[]) =>
    ids.map((id) => byClass.get(id)!.consistencyBps).filter((bps): bps is number => bps !== null);

  const teachers = [...teacherClasses].map(
    ([teacherId, classIds]): UploadConsistencyTeacherResult => ({
      teacherId,
      classIds,
      consistencyBps: floorMean(counted(classIds)),
    }),
  );

  const schoolValues = counted(classes.map((c) => c.classId));
  return {
    from: input.from,
    countedTo,
    schoolDays: schoolDays.length,
    classesCounted: schoolValues.length,
    consistencyBps: floorMean(schoolValues),
    classes,
    teachers,
  };
}

export interface ContentBonusStanding {
  /** The tier the consistency falls in (null below the first tier, or with no consistency). */
  tier: AiProgrammeTier | null;
  /** The next tier up, or null at the top. */
  nextTier: AiProgrammeTier | null;
  /** Where the bonus starts: the lowest tier that pays anything, or null when none does. */
  targetBps: number | null;
}

/**
 * Where an upload consistency stands on a content-bonus tier table (the licence's resolved
 * `contentBonusTiers`). Shows the tier only: whether the bonus is paid (it needs a conversion share
 * when `bonusRequiresConversionShare`) and how much is the revenue share engine's.
 */
export function contentBonusStanding(
  tiers: readonly AiProgrammeTier[],
  consistencyBps: number | null,
): ContentBonusStanding {
  const sorted = [...tiers].sort((a, b) => a.fromBps - b.fromBps);
  const target = sorted.find((t) => t.shareBps > 0)?.fromBps ?? null;
  const value = consistencyBps ?? -1;
  const tier = consistencyBps === null ? null : tierFor(sorted, value);
  const nextTier = sorted.find((t) => t.fromBps > value) ?? null;
  return {
    tier: tier ? { ...tier } : null,
    nextTier: nextTier ? { ...nextTier } : null,
    targetBps: target,
  };
}
