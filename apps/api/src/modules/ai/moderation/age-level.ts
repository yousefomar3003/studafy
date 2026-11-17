import type { AgeLevel } from "./policy";

const RANK: Record<AgeLevel, number> = { elementary: 0, middle: 1, high: 2 };

/** The level when the school recorded no date of birth: not the most permissive (QA-029). */
const UNKNOWN_AGE_LEVEL: AgeLevel = "middle";

/** Whole years between `dateOfBirth` (YYYY-MM-DD) and `now`. */
function ageOn(dateOfBirth: string, now: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  let age = now.getUTCFullYear() - year;
  const beforeBirthday =
    now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day);
  if (beforeBirthday) age -= 1;
  return age;
}

/** The level the student's age calls for: under 11 elementary, 11-13 middle, 14 and over high. */
export function ageLevelForBirthDate(dateOfBirth: string | null, now: Date): AgeLevel {
  const age = dateOfBirth ? ageOn(dateOfBirth, now) : null;
  if (age === null) return UNKNOWN_AGE_LEVEL;
  if (age < 11) return "elementary";
  if (age < 14) return "middle";
  return "high";
}

/**
 * The moderation level actually applied (QA-029): the server's, from the student's age, or the
 * client's if that is stricter. A client can never loosen the filter.
 */
export function effectiveAgeLevel(
  dateOfBirth: string | null,
  requested: AgeLevel | undefined,
  now: Date = new Date(),
): AgeLevel {
  const derived = ageLevelForBirthDate(dateOfBirth, now);
  return requested !== undefined && RANK[requested] < RANK[derived] ? requested : derived;
}
