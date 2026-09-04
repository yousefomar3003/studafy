import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:studafy_mobile/src/core/push/push_service.dart';

/// A no-op [PushService], for widget tests that pump the real [StudafyApp] tree.
///
/// [FirebasePushService] touches real Firebase Cloud Messaging the instant it's constructed
/// (`FirebaseMessaging.instance`), which throws `[core/no-app] No Firebase App '[DEFAULT]' has
/// been created` outside a real app that has already run `Firebase.initializeApp()` — this fake
/// is what lets `pumpStudafyApp` build `StudafyApp`'s real widget tree (which reads
/// `pushServiceProvider` in `didChangeDependencies`) without a platform push stack at all, the
/// same way it already fakes `AuthSession` and the crash reporter.
class FakePushService implements PushService {
  final _messageController = StreamController<RemoteMessage>.broadcast();
  final _tapController = StreamController<String>.broadcast();

  @override
  Stream<RemoteMessage> get onMessage => _messageController.stream;

  @override
  Stream<String> get onNotificationTap => _tapController.stream;

  @override
  Future<String?> initialize() async => null;

  @override
  Future<void> registerIfAuthenticated() async {}

  @override
  void dispose() {
    _messageController.close();
    _tapController.close();
  }
}
