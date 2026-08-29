import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/student/domain/material_ready_state.dart';

void main() {
  group('materialReadyStateFromWireName', () {
    const cases = {
      'uploaded': MaterialReadyState.pendingScan,
      'scanning': MaterialReadyState.scanning,
      'queued': MaterialReadyState.queued,
      'processing': MaterialReadyState.processing,
      'ready': MaterialReadyState.ready,
      'failed': MaterialReadyState.failed,
      'quarantined': MaterialReadyState.quarantined,
    };

    cases.forEach((wireName, expected) {
      test('maps "$wireName" to $expected', () {
        expect(materialReadyStateFromWireName(wireName), expected);
      });
    });

    test('falls back to processing for an unrecognized future wire value', () {
      expect(materialReadyStateFromWireName('archived'), MaterialReadyState.processing);
    });
  });

  group('MaterialReadyStateX.isOpenable', () {
    test('is true only for ready', () {
      for (final state in MaterialReadyState.values) {
        expect(state.isOpenable, state == MaterialReadyState.ready, reason: '$state');
      }
    });
  });
}
