import 'package:test/test.dart';

import '../../tool/coverage_gates.dart';

/// ST-245's ratchet policy: [gateHistory] may only gain entries that raise a threshold, never
/// lower one. This is what "enforced by config test" means in the acceptance criteria -- there
/// is no CI step that diffs the file against a previous commit; the invariant is checked here,
/// against the config as it stands in the working tree, every time `flutter test` runs.
void main() {
  group('coverage gate ratchet', () {
    test('history is non-empty', () {
      expect(gateHistory, isNotEmpty);
    });

    test('every threshold is a valid percentage', () {
      for (final gate in gateHistory) {
        expect(
          gate.apiServiceLayer,
          inInclusiveRange(0, 100),
          reason: '${gate.date}: apiServiceLayer out of range',
        );
        expect(
          gate.packages,
          inInclusiveRange(0, 100),
          reason: '${gate.date}: packages out of range',
        );
      }
    });

    test('dates only move forward', () {
      for (var i = 1; i < gateHistory.length; i++) {
        final previous = gateHistory[i - 1];
        final entry = gateHistory[i];
        expect(
          entry.date.compareTo(previous.date) > 0,
          isTrue,
          reason: '${entry.date} does not come after ${previous.date}',
        );
      }
    });

    test('no entry lowers a threshold the previous entry set', () {
      for (var i = 1; i < gateHistory.length; i++) {
        final previous = gateHistory[i - 1];
        final entry = gateHistory[i];
        expect(
          entry.apiServiceLayer,
          greaterThanOrEqualTo(previous.apiServiceLayer),
          reason:
              '${entry.date} lowers apiServiceLayer below the ${previous.date} threshold '
              '(${previous.apiServiceLayer}%) -- the ratchet only raises thresholds',
        );
        expect(
          entry.packages,
          greaterThanOrEqualTo(previous.packages),
          reason:
              '${entry.date} lowers packages below the ${previous.date} threshold '
              '(${previous.packages}%) -- the ratchet only raises thresholds',
        );
      }
    });

    test('the current threshold never exceeds the stated target', () {
      // Guards the other direction: a threshold above targetCoverageGate would mean the target
      // itself is stale and should be raised (or the entry is a typo), not the other way round.
      final current = currentCoverageGate;
      expect(
        current.apiServiceLayer,
        lessThanOrEqualTo(targetCoverageGate.apiServiceLayer),
      );
      expect(current.packages, lessThanOrEqualTo(targetCoverageGate.packages));
    });
  });
}
