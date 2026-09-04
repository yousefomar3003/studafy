/**
 * A `YYYY-MM-DD` date that is vanishingly unlikely to collide with a date any other run of this
 * suite (or the seed data) already used. Attendance session creation is idempotent on
 * (class_id, session_date, period) — a collision would silently replay a previous run's session
 * instead of creating a fresh one, and a fresh `open` session is exactly what the attendance journey
 * needs. Picked from a wide future range rather than "today" so same-day reruns (a developer
 * re-running the suite locally, or CI retrying a flake) still get a fresh date.
 */
export function uniqueFutureIsoDate(): string {
  const year = 2030 + Math.floor(Math.random() * 50);
  const month = Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  const date = new Date(Date.UTC(year, month, day));
  return date.toISOString().slice(0, 10);
}
