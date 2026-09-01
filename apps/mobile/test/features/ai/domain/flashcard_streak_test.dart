import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/ai/domain/flashcard_streak.dart';

void main() {
  final today = DateTime(2026, 3, 10, 21, 45);

  DateTime daysAgo(int n) => DateTime(2026, 3, 10 - n, 8, 0);

  group('computeStreak', () {
    test('zero when nothing has ever been reviewed', () {
      expect(computeStreak(const {}, today: today), 0);
    });

    test('one when only today has a review', () {
      expect(computeStreak({daysAgo(0)}, today: today), 1);
    });

    test('a review yesterday keeps the streak alive even if today has none yet', () {
      expect(computeStreak({daysAgo(1)}, today: today), 1);
    });

    test('counts the unbroken run ending today', () {
      final days = {daysAgo(0), daysAgo(1), daysAgo(2), daysAgo(3)};
      expect(computeStreak(days, today: today), 4);
    });

    test('a gap breaks the streak at the gap, not before it', () {
      // Reviewed today and two days ago, but not yesterday -- the run from today is length 1.
      final days = {daysAgo(0), daysAgo(2)};
      expect(computeStreak(days, today: today), 1);
    });

    test('zero when the most recent review was two or more days ago', () {
      expect(computeStreak({daysAgo(2)}, today: today), 0);
    });

    test('ignores time-of-day when matching calendar days', () {
      final reviewedAtDawn = DateTime(2026, 3, 10, 0, 1);
      final checkedAtNight = DateTime(2026, 3, 10, 23, 59);
      expect(computeStreak({reviewedAtDawn}, today: checkedAtNight), 1);
    });
  });
}
