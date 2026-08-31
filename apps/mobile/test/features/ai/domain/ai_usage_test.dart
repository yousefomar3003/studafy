import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_usage.dart';

AiUsage _usage({required int budget, required int usedTokens, int heldTokens = 0}) {
  return AiUsage(
    budget: budget,
    usedTokens: usedTokens,
    heldTokens: heldTokens,
    remaining: budget - usedTokens - heldTokens,
    periodEnd: DateTime(2026, 2, 1),
  );
}

void main() {
  group('AiUsage.usedFraction', () {
    test('is the fraction of budget used plus held', () {
      final usage = _usage(budget: 1000, usedTokens: 200, heldTokens: 50);

      expect(usage.usedFraction, closeTo(0.25, 1e-9));
    });

    test('is 0 for a fresh period', () {
      final usage = _usage(budget: 1000, usedTokens: 0);

      expect(usage.usedFraction, 0);
    });

    test('clamps to 1 when held tokens push usage past budget', () {
      final usage = _usage(budget: 1000, usedTokens: 950, heldTokens: 100);

      expect(usage.usedFraction, 1);
    });

    test('is 0 rather than dividing by zero for a zero-budget plan', () {
      final usage = _usage(budget: 0, usedTokens: 0);

      expect(usage.usedFraction, 0);
    });
  });
}
