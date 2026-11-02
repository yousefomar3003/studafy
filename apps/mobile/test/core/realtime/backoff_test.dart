import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/realtime/backoff.dart';

void main() {
  group('RealtimeBackoff.delayFor', () {
    const backoff = RealtimeBackoff(
      baseDelay: Duration(seconds: 1),
      maxDelay: Duration(seconds: 30),
      jitterRatio: 0.2,
    );

    double noJitter() =>
        0.5; // (0.5 * 2 - 1) * ratio == 0, i.e. no jitter applied.

    test('grows exponentially from the base delay with no jitter', () {
      expect(backoff.delayFor(0, noJitter), const Duration(seconds: 1));
      expect(backoff.delayFor(1, noJitter), const Duration(seconds: 2));
      expect(backoff.delayFor(2, noJitter), const Duration(seconds: 4));
      expect(backoff.delayFor(3, noJitter), const Duration(seconds: 8));
    });

    test('caps the raw delay at maxDelay before jitter', () {
      expect(backoff.delayFor(10, noJitter), const Duration(seconds: 30));
    });

    test('treats a negative attempt as attempt 0', () {
      expect(backoff.delayFor(-1, noJitter), const Duration(seconds: 1));
    });

    test('applies positive jitter up to jitterRatio', () {
      // random() == 1 -> jitter fraction == +jitterRatio.
      final delay = backoff.delayFor(0, () => 1.0);
      expect(delay, const Duration(milliseconds: 1200));
    });

    test('applies negative jitter down to -jitterRatio', () {
      // random() == 0 -> jitter fraction == -jitterRatio.
      final delay = backoff.delayFor(0, () => 0.0);
      expect(delay, const Duration(milliseconds: 800));
    });

    test('never returns a negative delay', () {
      const aggressive = RealtimeBackoff(
        baseDelay: Duration(milliseconds: 10),
        maxDelay: Duration(milliseconds: 10),
        jitterRatio: 5,
      );
      final delay = aggressive.delayFor(0, () => 0.0);
      expect(delay.isNegative, isFalse);
    });
  });
}
