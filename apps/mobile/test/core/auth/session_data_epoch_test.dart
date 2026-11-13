import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/core/auth/authenticated_dio.dart';
import 'package:studafy_mobile/src/core/config/app_config.dart';
import 'package:studafy_mobile/src/core/config/app_environment.dart';
import 'package:studafy_mobile/src/core/di/app_providers.dart';

import '../../support/fake_secure_token_store.dart';
import '../../support/pump_studafy_app.dart';

/// A parent's first sign-in: screens that loaded while the Terms were pending cached a 403. After
/// acceptance the session object is the same, so only the epoch bump makes them load again.
void main() {
  test('bumping the session epoch rebuilds everything built on the API clients', () async {
    final container = ProviderContainer(
      overrides: [
        appConfigProvider.overrideWithValue(AppConfig.fromEnvironment(AppEnvironment.dev)),
        authSessionProvider.overrideWithValue(
          await fakeAuthenticatedSession(roles: const ['PARENT']),
        ),
        secureTokenStoreProvider.overrideWithValue(FakeSecureTokenStore()),
      ],
    );
    addTearDown(container.dispose);

    var generatedBuilds = 0;
    var dioBuilds = 0;
    final onGenerated = Provider<int>((ref) {
      ref.watch(apiClientProvider);
      return ++generatedBuilds;
    });
    final onDio = Provider<int>((ref) {
      authenticatedDio(ref);
      return ++dioBuilds;
    });

    container.listen(onGenerated, (_, _) {});
    container.listen(onDio, (_, _) {});
    expect((generatedBuilds, dioBuilds), (1, 1));

    container.read(sessionDataEpochProvider.notifier).bump();
    container.read(onGenerated);
    container.read(onDio);

    expect((generatedBuilds, dioBuilds), (2, 2));
  });
}
