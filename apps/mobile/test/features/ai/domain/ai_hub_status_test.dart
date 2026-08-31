import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_hub_status.dart';

void main() {
  group('aiHubStatusFromErrorCode', () {
    test('maps AI_SCHOOL_INACTIVE to AiHubSchoolInactive', () {
      expect(aiHubStatusFromErrorCode('AI_SCHOOL_INACTIVE'), isA<AiHubSchoolInactive>());
    });

    test('maps AI_SUBSCRIPTION_INACTIVE to AiHubUnsubscribed', () {
      expect(aiHubStatusFromErrorCode('AI_SUBSCRIPTION_INACTIVE'), isA<AiHubUnsubscribed>());
    });

    test('returns null for an unrecognized code, so the caller rethrows', () {
      expect(aiHubStatusFromErrorCode('AI_QUOTA_UNAVAILABLE'), isNull);
    });

    test('returns null for no code (a non-problem or network failure)', () {
      expect(aiHubStatusFromErrorCode(null), isNull);
    });
  });
}
