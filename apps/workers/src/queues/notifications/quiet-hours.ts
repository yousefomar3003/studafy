/**
 * Quiet hours evaluation (ST-139).
 *
 * ## Where the timezone maths happens, and why it is not here
 *
 * The recipient's local wall-clock time is computed in SQL, by the query that loads their settings:
 *
 *   (CURRENT_TIMESTAMP AT TIME ZONE settings.timezone)::time
 *
 * PostgreSQL ships and updates the IANA tz database; the Bun runtime's copy is whatever the base
 * image happened to bake in, and a stale one is wrong exactly when a country changes its rules —
 * which is the only time this code's answer differs from the naive one. Doing the conversion in the
 * database also means "what time is it for this user" is answered once per recipient in the same
 * round trip as their preferences, rather than in a second call.
 *
 * What is left here is the part that is genuinely logic rather than a lookup: comparing a wall-clock
 * time against a window that may wrap past midnight. That is pure, and therefore unit-testable
 * without a database.
 */

/** Notification types that ignore quiet hours. Empty today, and that is a deliberate statement. */
const URGENT_NOTIFICATION_TYPES = new Set<string>();

/**
 * Whether a notification of this type may be delivered inside a recipient's quiet hours.
 *
 * Nothing is urgent yet. GRADE_POSTED certainly is not — a grade published at 02:00 is a grade the
 * student can read at 08:00. Modelled as a code-level set rather than a database column because
 * urgency is a property of the notification *type*, which is an enum in the schema and a constant
 * in packages/constants; a per-row column would let two notifications of the same type disagree
 * about whether they can wake someone up.
 */
export function isUrgent(notificationType: string): boolean {
  return URGENT_NOTIFICATION_TYPES.has(notificationType);
}

/**
 * Whether `localTime` falls inside the window [`start`, `end`].
 *
 * All three are `HH:MM` or `HH:MM:SS` wall-clock strings in the same timezone, which is what makes
 * a lexicographic comparison correct: zero-padded 24-hour time sorts in chronological order.
 *
 * The wrap case is the one that matters. A quiet window of 22:00–07:00 has `start > end` and does
 * not describe an interval on a single day — it describes the union of two, so the test flips from
 * AND to OR. Getting this backwards produces a rule that is quiet all day except when the user
 * asked for quiet, which is both the most likely bug here and completely silent.
 *
 * Both bounds are inclusive. A notification landing exactly on 22:00:00 is inside the window the
 * user asked to be left alone in; treating the boundary as outside would be a one-second hole in a
 * rule whose whole purpose is not to have holes.
 */
export function isWithinQuietHours(
  localTime: string,
  start: string | null,
  end: string | null,
): boolean {
  if (start === null || end === null) return false;

  const now = normalizeTime(localTime);
  const from = normalizeTime(start);
  const to = normalizeTime(end);

  // A window whose ends coincide is a point, not a day. Treated as "no quiet hours" rather than
  // "always quiet": the latter would silently suppress every notification for that user forever,
  // and the database cannot distinguish a deliberate 00:00–00:00 from a botched form submission.
  if (from === to) return false;

  return from < to
    ? now >= from && now <= to
    : // Wraps past midnight: inside if we are after the start OR before the end.
      now >= from || now <= to;
}

/** `HH:MM` and `HH:MM:SS.mmm` both reduce to `HH:MM:SS`, so comparisons are like-for-like. */
function normalizeTime(value: string): string {
  const [hours = "00", minutes = "00", rest = "00"] = value.split(":");
  const seconds = rest.split(".")[0] ?? "00";
  return `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}:${seconds.padStart(2, "0")}`;
}
