/// The review streak: how many consecutive days (ending today or yesterday) the student has
/// submitted at least one flashcard review.
///
/// Honest limit: the API tracks per-card SM-2 progress, not a cross-deck "days studied" log — there
/// is no server concept of a streak. [computeStreak] is a pure, unit-tested function of the local
/// review-day log `data/flashcard_library_store.dart` keeps (one date per day a rating was
/// successfully synced), the same "pure function of its inputs" posture the server's own
/// `scheduleCard` takes, just computed on-device because the input it runs on is on-device.
library;

/// Normalizes [date] to a date-only value (no time-of-day, no timezone offset) so day comparisons
/// are exact regardless of what time within the day a review happened.
DateTime dateOnly(DateTime date) => DateTime(date.year, date.month, date.day);

/// Counts the run of consecutive calendar days, walking backward from [today], that appear in
/// [reviewedDays]. A day with no review breaks the run immediately — this is a *current* streak,
/// not a best-ever one.
///
/// Today itself missing a review does not yet break the streak (the student may simply not have
/// studied *yet* today) as long as yesterday was reviewed; any other gap does.
int computeStreak(Set<DateTime> reviewedDays, {required DateTime today}) {
  final normalizedToday = dateOnly(today);
  final days = reviewedDays.map(dateOnly).toSet();

  var cursor = normalizedToday;
  if (!days.contains(cursor)) {
    cursor = cursor.subtract(const Duration(days: 1));
    if (!days.contains(cursor)) return 0;
  }

  var streak = 0;
  while (days.contains(cursor)) {
    streak++;
    cursor = cursor.subtract(const Duration(days: 1));
  }
  return streak;
}
