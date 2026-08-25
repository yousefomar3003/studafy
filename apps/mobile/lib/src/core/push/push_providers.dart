import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_notifier.dart';
import '../di/app_providers.dart';
import 'push_service.dart';

/// Background message handler — must be a top-level function.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  // Background messages are displayed by the OS automatically when the
  // notification payload is present (which the workers always include).
  // No app-side action needed here — tap handling is wired separately.
}

/// Creates and configures the [PushService] with the current session's auth
/// token and the API base URL. Disposed when the provider container tears down.
final pushServiceProvider = Provider<PushService>((ref) {
  final networkConfig = ref.watch(networkConfigProvider);
  final session = ref.watch(authSessionProvider);

  final service = PushService(
    apiBaseUrl: networkConfig.apiBaseUrl,
    getToken: session.tokenProvider,
  );

  ref.onDispose(service.dispose);
  return service;
});

/// Notifier that manages push initialization state.
///
/// Separate from [PushService] so the app can await initialization without
/// blocking the provider graph. The service is created eagerly; init is called
/// explicitly from the bootstrap or auth flow.
class PushInitNotifier extends AsyncNotifier<void> {
  @override
  Future<void> build() async {}

  /// Initialize push (request permission, get token, register).
  /// No-op if already initialized.
  Future<void> initialize() async {
    if (state.hasValue) return;
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      final service = ref.read(pushServiceProvider);
      await service.initialize();
    });
  }
}

final pushInitProvider =
    AsyncNotifierProvider<PushInitNotifier, void>(PushInitNotifier.new);
