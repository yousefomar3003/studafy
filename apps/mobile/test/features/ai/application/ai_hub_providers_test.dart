import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/core/features/features_providers.dart';
import 'package:studafy_mobile/src/core/features/my_features.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_hub_providers.dart';
import 'package:studafy_mobile/src/features/ai/data/ai_hub_client.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_hub_status.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_usage.dart';

import '../../../core/features/feature_fixtures.dart';

/// The AI tab's status follows the person and their feature list: it is re-read on sign-in and
/// whenever `GET /api/me/features` reloads, so it cannot stay "locked" while the rest of the app
/// (the subscriber logo, feature gates) already shows the add-on.
class _FakeHubClient implements AiHubClient {
  bool subscribed = false;
  int calls = 0;

  @override
  Future<AiUsage> usage() async {
    calls += 1;
    if (subscribed) {
      return AiUsage(
        budget: 1000,
        usedTokens: 0,
        heldTokens: 0,
        remaining: 1000,
        periodEnd: DateTime(2026, 12, 1),
      );
    }
    final request = RequestOptions(path: '/api/ai/usage');
    throw DioException(
      requestOptions: request,
      response: Response(requestOptions: request, statusCode: 402),
      error: const ApiException(
        status: 402,
        title: 'Payment Required',
        code: 'AI_SUBSCRIPTION_INACTIVE',
      ),
    );
  }
}

class _FeaturesClient implements MyFeaturesClient {
  @override
  Future<MyFeatures> fetch() async => featuresFrom(const []);
}

class _AuthStatusNotifier extends Notifier<AuthStatus> {
  @override
  AuthStatus build() => AuthStatus.authenticated;
}

final _authStatus = NotifierProvider<_AuthStatusNotifier, AuthStatus>(_AuthStatusNotifier.new);

Future<void> _settle() => Future<void>.delayed(Duration.zero);

void main() {
  late _FakeHubClient hub;
  late ProviderContainer container;

  setUp(() {
    hub = _FakeHubClient();
    container = ProviderContainer(
      overrides: [
        aiHubClientProvider.overrideWithValue(hub),
        myFeaturesClientProvider.overrideWithValue(_FeaturesClient()),
        authStatusProvider.overrideWith((ref) => ref.watch(_authStatus)),
      ],
    );
    addTearDown(container.dispose);
    // The AI tab keeps the status alive while it is on screen.
    container.listen(aiHubStatusProvider, (_, _) {});
    container.listen(myFeaturesProvider, (_, _) {});
  });

  test('re-reads when the feature list reloads (e.g. an add-on activated over realtime)', () async {
    expect(await container.read(aiHubStatusProvider.future), isA<AiHubUnsubscribed>());
    await container.read(myFeaturesProvider.future);
    await _settle();
    final callsAfterFirstLoad = hub.calls;

    hub.subscribed = true;
    container.invalidate(myFeaturesProvider);
    await container.read(myFeaturesProvider.future);
    await _settle();

    expect(hub.calls, callsAfterFirstLoad + 1);
    expect(await container.read(aiHubStatusProvider.future), isA<AiHubSubscribed>());
  });

  test('re-reads when a different person signs in', () async {
    expect(await container.read(aiHubStatusProvider.future), isA<AiHubUnsubscribed>());

    hub.subscribed = true;
    container.read(_authStatus.notifier).state = AuthStatus.unauthenticated;
    await _settle();
    container.read(_authStatus.notifier).state = AuthStatus.authenticated;
    await _settle();

    expect(await container.read(aiHubStatusProvider.future), isA<AiHubSubscribed>());
  });
}
