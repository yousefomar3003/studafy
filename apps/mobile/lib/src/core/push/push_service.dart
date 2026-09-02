import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../api/auth_interceptor.dart';

const _androidChannelId = 'studafy_push';
const _androidChannelName = 'Push Notifications';

/// Wraps Firebase Cloud Messaging: permission, token lifecycle, and API registration.
///
/// [getToken] is the same async provider the [AuthInterceptor] uses — the push
/// service needs a live bearer token to call POST /api/auth/devices. When null
/// is returned the user is signed out and registration is skipped.
class PushService {
  PushService({
    required Uri apiBaseUrl,
    required TokenProvider getToken,
  })  : _getToken = getToken,
        _dio = Dio(BaseOptions(baseUrl: apiBaseUrl.toString()));

  final TokenProvider _getToken;
  final Dio _dio;
  final FirebaseMessaging _messaging = FirebaseMessaging.instance;
  final FlutterLocalNotificationsPlugin _localNotifications =
      FlutterLocalNotificationsPlugin();

  final _messageController = StreamController<RemoteMessage>.broadcast();
  final _tapController = StreamController<String>.broadcast();

  StreamSubscription<RemoteMessage>? _foregroundSub;
  StreamSubscription<RemoteMessage>? _tapSub;
  StreamSubscription<String>? _tokenRefreshSub;

  bool _initialized = false;

  /// Stream of messages received while the app is in the foreground.
  Stream<RemoteMessage> get onMessage => _messageController.stream;

  /// Stream of deep-link routes extracted from notification taps.
  Stream<String> get onNotificationTap => _tapController.stream;

  /// Initialize Firebase, request permission, get token, register with API.
  ///
  /// Returns the FCM token on success, null if permission denied or init failed.
  Future<String?> initialize() async {
    if (_initialized) return await _messaging.getToken();
    _initialized = true;

    await Firebase.initializeApp();

    await _initLocalNotifications();

    final settings = await _messaging.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );

    if (settings.authorizationStatus != AuthorizationStatus.authorized) {
      return null;
    }

    // `onMessage` / `onMessageOpenedApp` are static on `FirebaseMessaging`; only
    // `onTokenRefresh` is an instance stream.
    _foregroundSub = FirebaseMessaging.onMessage.listen(_onForegroundMessage);
    _tapSub = FirebaseMessaging.onMessageOpenedApp.listen(_onTap);
    _tokenRefreshSub = _messaging.onTokenRefresh.listen(_onTokenRefresh);

    final token = await _messaging.getToken();
    if (token != null) {
      await _registerToken(token);
    }

    final initialMessage = await _messaging.getInitialMessage();
    if (initialMessage != null) {
      _onTap(initialMessage);
    }

    return token;
  }

  /// Manually trigger registration (e.g. after login when the service was
  /// already initialized but had no auth token at the time).
  Future<void> registerIfAuthenticated() async {
    final token = await _messaging.getToken();
    if (token != null) {
      await _registerToken(token);
    }
  }

  /// Tear down listeners. Call on logout or app dispose.
  void dispose() {
    _foregroundSub?.cancel();
    _tapSub?.cancel();
    _tokenRefreshSub?.cancel();
    _messageController.close();
    _tapController.close();
    _dio.close(force: true);
  }

  // -- Internal --------------------------------------------------------------

  Future<void> _initLocalNotifications() async {
    const androidSettings =
        AndroidInitializationSettings('@mipmap/ic_launcher');
    const iosSettings = DarwinInitializationSettings();
    const settings =
        InitializationSettings(android: androidSettings, iOS: iosSettings);

    await _localNotifications.initialize(
      settings,
      onDidReceiveNotificationResponse: (response) {
        final payload = response.payload;
        if (payload != null && payload.isNotEmpty) {
          final data =
              jsonDecode(payload) as Map<String, dynamic>;
          _handleTap(data);
        }
      },
    );

    const androidChannel = AndroidNotificationChannel(
      _androidChannelId,
      _androidChannelName,
      importance: Importance.high,
    );
    await _localNotifications
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(androidChannel);
  }

  void _onForegroundMessage(RemoteMessage message) {
    _messageController.add(message);

    final notification = message.notification;
    if (notification == null) return;

    _localNotifications.show(
      notification.hashCode,
      notification.title,
      notification.body,
      const NotificationDetails(
        android: AndroidNotificationDetails(
          _androidChannelId,
          _androidChannelName,
          importance: Importance.high,
          priority: Priority.high,
        ),
      ),
      payload: jsonEncode(message.data),
    );
  }

  void _onTap(RemoteMessage message) {
    _handleTap(message.data);
  }

  void _handleTap(Map<String, dynamic> data) {
    final route = data['route'];
    if (route is String && route.isNotEmpty) {
      _tapController.add(route);
    }
  }

  Future<void> _onTokenRefresh(String token) async {
    await _registerToken(token);
  }

  Future<void> _registerToken(String fcmToken) async {
    final bearerToken = await _getToken();
    if (bearerToken == null) return;

    final platform =
        defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android';

    try {
      await _dio.post(
        '/api/auth/devices',
        data: {'fcm_token': fcmToken, 'platform': platform},
        options: Options(headers: {'Authorization': 'Bearer $bearerToken'}),
      );
    } catch (e) {
      debugPrint('FCM token registration failed: $e');
    }
  }
}
