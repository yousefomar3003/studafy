import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_study_providers.dart';
import 'package:studafy_mobile/src/features/ai/data/ai_study_client.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_study.dart';

class _FakeAiStudyClient extends Fake implements AiStudyClient {
  _FakeAiStudyClient(this.handler);

  final Future<AiUsage> Function() handler;

  @override
  Future<AiUsage> usage() => handler();
}

DioException _problem(int status, String code) {
  final requestOptions = RequestOptions(path: '/api/ai/usage');
  return DioException(
    requestOptions: requestOptions,
    response: Response<dynamic>(
      requestOptions: requestOptions,
      statusCode: status,
    ),
    type: DioExceptionType.badResponse,
    error: ApiException(status: status, title: 'failed', code: code),
  );
}

ProviderContainer _container(Future<AiUsage> Function() handler) {
  final container = ProviderContainer(
    // No retries: these assert on the first outcome, not on Riverpod's retry timing.
    retry: (_, _) => null,
    overrides: [
      aiStudyClientProvider.overrideWithValue(_FakeAiStudyClient(handler)),
    ],
  );
  addTearDown(container.dispose);
  container.listen(aiUsageProvider, (_, _) {});
  return container;
}

void main() {
  test('returns the quota when the student has AI access', () async {
    const usage = AiUsage(
      active: true,
      budget: 1000,
      usedTokens: 10,
      heldTokens: 0,
      remaining: 990,
    );
    final container = _container(() async => usage);

    expect(await container.read(aiUsageProvider.future), same(usage));
  });

  test(
    '402 AI_SUBSCRIPTION_INACTIVE degrades to an empty quota instead of an error',
    () async {
      final container = _container(
        () => Future.error(_problem(402, 'AI_SUBSCRIPTION_INACTIVE')),
      );

      final usage = await container.read(aiUsageProvider.future);
      expect(usage.hasBudget, isFalse);
      expect(usage.active, isFalse);
    },
  );

  test('403 AI_SCHOOL_INACTIVE degrades to an empty quota too', () async {
    final container = _container(
      () => Future.error(_problem(403, 'AI_SCHOOL_INACTIVE')),
    );

    expect((await container.read(aiUsageProvider.future)).hasBudget, isFalse);
  });

  test('any other failure still surfaces as an error', () async {
    final container = _container(
      () => Future.error(_problem(503, 'AI_QUOTA_UNAVAILABLE')),
    );

    await expectLater(
      container.read(aiUsageProvider.future),
      throwsA(isA<DioException>()),
    );
  });
}
