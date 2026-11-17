import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:studafy_mobile/src/core/push/push_service.dart';

/// A no-op [PushService], for widget tests that pump the real [StudafyApp] tree.
///
/// [FirebasePushService] reaches real Firebase Cloud Messaging once its `initialize()` runs
/// (`FirebaseMessaging.instance`, `Firebase.initializeApp()`), which throws `[core/no-app] No
/// Firebase App '[DEFAULT]' has been created` outside a real app that has already run
/// `Firebase.initializeApp()` — this fake is what lets `pumpStudafyApp` build `StudafyApp`'s real
/// widget tree (which reads `pushServiceProvider` in `didChangeDependencies`) without a platform
/// push stack at all, the same way it already fakes `AuthSession` and the crash reporter.
class FakePushService implements PushService {
  /// [canRequestPermission]'s answer: whether the OS prompt is still unanswered. Defaults to false,
  /// so the shell shows no permission banner unless a test asks for one.
  FakePushService({this.permissionUnanswered = false});

  final bool permissionUnanswered;

  /// How many times [requestPermission] ran — i.e. the OS prompt would have been shown.
  int permissionRequests = 0;

  final _messageController = StreamController<RemoteMessage>.broadcast();
  final _tapController = StreamController<PushTap>.broadcast();

  /// [permissionStatus]'s answer.
  PushPermission permission = PushPermission.granted;

  /// [currentToken]'s answer.
  String? token = 'fake-fcm-token';

  /// Access tokens [registerForAccount] was called with.
  final List<String> registeredAccounts = [];

  /// How many times [openSystemSettings] ran.
  int settingsOpened = 0;

  @override
  Stream<RemoteMessage> get onMessage => _messageController.stream;

  @override
  Stream<PushTap> get onNotificationTap => _tapController.stream;

  @override
  Future<String?> initialize() async => null;

  @override
  Future<bool> canRequestPermission() async => permissionUnanswered;

  @override
  Future<String?> requestPermission() async {
    permissionRequests++;
    return null;
  }

  /// When set, [registerIfAuthenticated] fails with it: a phone that could not be registered.
  PushRegistrationException? registrationError;

  @override
  Future<void> registerIfAuthenticated() async {
    final error = registrationError;
    if (error != null) throw error;
  }

  @override
  Future<String?> currentToken() async => token;

  @override
  Future<void> registerForAccount(String accessToken) async {
    registeredAccounts.add(accessToken);
  }

  @override
  Future<PushPermission> permissionStatus() async => permission;

  @override
  Future<void> openSystemSettings() async {
    settingsOpened++;
  }

  /// [PushService.problem]'s answer: why push setup failed, or null.
  @override
  String? problem;

  /// How many times [retrySetup] ran ("Try again").
  int setupRetries = 0;

  /// Runs on [retrySetup], e.g. to make the retry succeed by changing [permission] and [problem].
  void Function(FakePushService push)? onRetrySetup;

  @override
  Future<String?> retrySetup() async {
    setupRetries++;
    onRetrySetup?.call(this);
    return null;
  }

  @override
  void dispose() {
    _messageController.close();
    _tapController.close();
  }

  /// Simulates the user tapping a notification whose payload resolved to [route]
  /// (`resolveNotificationTapRoute`) — [StudafyApp] listens on [onNotificationTap] and pushes it
  /// via `GoRouter`, exactly as [FirebasePushService] would after a real tap.
  void simulateNotificationTap(String route, {String? userId}) =>
      _tapController.add(PushTap(route, userId: userId));
}
