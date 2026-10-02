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
///
/// Always a real [FirebasePushService] here — the seam tests use is overriding this whole
/// provider (`pumpStudafyApp`'s `pushServiceProvider.overrideWithValue(FakePushService())`), not a
/// runtime branch on environment, since [FirebasePushService] still needs a real
/// `Firebase.initializeApp()` once its `initialize()` is reached — impossible in a widget test.
final pushServiceProvider = Provider<PushService>((ref) {
  final networkConfig = ref.watch(networkConfigProvider);
  final session = ref.watch(authSessionProvider);

  final service = FirebasePushService(
    apiBaseUrl: networkConfig.apiBaseUrl,
    getToken: () => session.tokenProvider,
  );

  ref.onDispose(service.dispose);
  return service;
});

/// Where push setup stands for this app session.
enum PushSetup {
  /// Not started: the user isn't signed in yet.
  idle,

  /// Initializing, or waiting on the OS permission prompt.
  inProgress,

  /// The OS permission prompt is unanswered. The shell explains what notifications are for and
  /// offers to continue to the prompt ([PushSetupNotifier.requestPermission]).
  needsPermission,

  /// Finished: registered, or permission refused or unavailable.
  done,
}

/// Drives push setup once the user is signed in: registers straight away when permission is
/// already granted, and otherwise holds at [PushSetup.needsPermission] until the user has read why
/// the app asks. The OS prompt is never shown cold.
class PushSetupNotifier extends Notifier<PushSetup> {
  @override
  PushSetup build() => PushSetup.idle;

  /// Initialize push and register if permission is already granted. No-op after the first call.
  Future<void> initialize() async {
    if (state != PushSetup.idle) return;
    state = PushSetup.inProgress;
    try {
      final service = ref.read(pushServiceProvider);
      final token = await service.initialize();
      state = token == null && await service.canRequestPermission()
          ? PushSetup.needsPermission
          : PushSetup.done;
    } catch (_) {
      state = PushSetup.done;
    }
  }

  /// Show the OS permission prompt, then register if granted.
  Future<void> requestPermission() async {
    if (state != PushSetup.needsPermission) return;
    state = PushSetup.inProgress;
    try {
      await ref.read(pushServiceProvider).requestPermission();
    } catch (_) {
      // Push is best-effort; a failure here leaves the app usable without it.
    } finally {
      state = PushSetup.done;
    }
  }
}

final pushSetupProvider = NotifierProvider<PushSetupNotifier, PushSetup>(
  PushSetupNotifier.new,
);
