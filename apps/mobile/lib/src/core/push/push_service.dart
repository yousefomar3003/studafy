import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/auth_interceptor.dart';
import '../router/route_paths.dart';
import '../../features/notifications/domain/notification_target.dart';

const _androidChannelId = 'studafy_push';
const _androidChannelName = 'Push Notifications';
const _permissionRequestedKey = 'push_permission_requested';

/// The route to deep-link to for a tapped notification's FCM `data` payload, or null to navigate
/// nowhere.
///
/// `ATTENDANCE_ALERT` is special-cased ahead of the payload's own `route`: that type's
/// server-side template is the course-scoped `/courses/{courseId}/attendance`, but an
/// attendance-alert notification's metadata carries a student id, not a course id, so the
/// template placeholder is never filled in and `route` arrives empty. `notification_type` itself
/// is always present (see `buildDataPayload` on the delivery worker), so routing on it directly
/// reaches the parent's alert center regardless of what `route` says.
///
/// Any other route is followed only when the app can open it on its own
/// ([isOpenableNotificationRoute]); otherwise the tap opens the notification inbox, where the
/// notice is listed in full. Server templates for many types point at web-only pages or still
/// hold `{placeholders}`, and pushing those would land on an error page.
String? resolveNotificationTapRoute(Map<String, dynamic> data) {
  final type = data['notification_type'];
  if (type == 'ATTENDANCE_ALERT' || type == 'ATTENDANCE_MARKED') {
    return RoutePaths.parentAlerts;
  }
  final route = data['route'];
  if (route is String && isOpenableNotificationRoute(route)) return route;
  return type is String && type.isNotEmpty ? RoutePaths.notifications : null;
}

/// A tapped notification: where to go, and which account it was for. [userId] is the recipient
/// the server named in the payload (`user_id`); on a phone with several signed-in accounts the app
/// switches to that account before opening [route]. Null on payloads from older servers.
@immutable
class PushTap {
  const PushTap(this.route, {this.userId});

  final String route;
  final String? userId;
}

/// Why this phone could not be signed up for notifications: no push token (notifications turned
/// off, or Firebase could not issue one) or the API refused the registration. [reason] is a short,
/// token-free description shown on the notification settings screen and sent to crash reporting,
/// so a phone that silently gets nothing can say why.
class PushRegistrationException implements Exception {
  const PushRegistrationException(this.reason);

  final String reason;

  @override
  String toString() => 'PushRegistrationException: $reason';
}

/// Receives push setup failures that would otherwise be invisible on a release build: token
/// fetches and device registrations that fail in the background. Wired to the crash reporter.
typedef PushErrorReporter = void Function(Object error, StackTrace stack, String reason);

/// What the phone allows for this app's notifications.
enum PushPermission {
  /// Notifications show (including iOS "provisional", delivered quietly).
  granted,

  /// Turned off in the phone's settings, or refused. Only the settings app can turn them back on.
  denied,

  /// Never asked yet: the app can show the OS prompt.
  notDetermined,

  /// Push isn't available in this build (no Firebase configuration).
  unavailable,
}

/// [pushServiceProvider]'s contract — the surface [StudafyApp] and [PushSetupNotifier] depend on.
///
/// A real deployment always gets [FirebasePushService]; widget tests override the provider with a
/// no-op fake instead (`test/support/fake_push_service.dart`) — reaching the Firebase Messaging
/// platform (`FirebaseMessaging.instance`, `Firebase.initializeApp()`) requires a real app, which
/// a widget test can never provide, so the service's real code paths stay production-only.
abstract class PushService {
  /// Stream of messages received while the app is in the foreground.
  Stream<RemoteMessage> get onMessage;

  /// Taps on notifications, with the route to open and the account they were for.
  Stream<PushTap> get onNotificationTap;

  /// Initialize Firebase and, if notification permission is already granted, get the token and
  /// register it with the API. Never shows the OS permission prompt — see [requestPermission].
  ///
  /// Returns the FCM token on success, null if permission isn't granted or init failed.
  Future<String?> initialize();

  /// Whether the OS notification prompt is still unanswered, so [requestPermission] would show it.
  /// The app explains what notifications are for before it calls [requestPermission].
  Future<bool> canRequestPermission();

  /// Show the OS notification permission prompt and, if granted, register as [initialize] does.
  Future<String?> requestPermission();

  /// Manually trigger registration (e.g. after login when the service was
  /// already initialized but had no auth token at the time).
  ///
  /// Throws [PushRegistrationException] when this phone could not be registered, so a caller that
  /// tells the user something ("Send a test notification") can say why instead of claiming success.
  Future<void> registerIfAuthenticated();

  /// This phone's push token, or null when push isn't set up (no permission, no Firebase). Never
  /// prompts. Sent on sign-out so the server stops routing that account's notices here.
  Future<String?> currentToken();

  /// Registers this phone's token for another signed-in account, using that account's own access
  /// token: a child's account a parent just added to the phone, which is not the active one.
  Future<void> registerForAccount(String accessToken);

  /// What the phone currently allows. Never prompts.
  Future<PushPermission> permissionStatus();

  /// Opens this app's notification settings in the phone's Settings app.
  Future<void> openSystemSettings();

  /// Tear down listeners. Call on logout or app dispose.
  void dispose();
}

/// Wraps Firebase Cloud Messaging: permission, token lifecycle, and API registration.
///
/// [getToken] is the same async provider the [AuthInterceptor] uses — the push
/// service needs a live bearer token to call POST /api/auth/devices. When null
/// is returned the user is signed out and registration is skipped.
class FirebasePushService implements PushService {
  FirebasePushService({
    required Uri apiBaseUrl,
    required this._getToken,
    FlutterSecureStorage? storage,
    this._onError,
  }) : _dio = Dio(BaseOptions(baseUrl: apiBaseUrl.toString())),
       _storage = storage ?? const FlutterSecureStorage();

  final TokenProvider _getToken;
  final PushErrorReporter? _onError;
  final Dio _dio;
  final FlutterSecureStorage _storage;

  // Lazily resolved in `_ensureFirebase()` rather than in the constructor so constructing the
  // service never touches Firebase — the root widget subscribes to push taps on the first frame,
  // which now runs before `Firebase.initializeApp()` completes (deferred init, see
  // app_bootstrap.dart). The first Firebase touch is therefore `initialize()`, which is gated on
  // authentication and can itself await Firebase setup.
  late final FirebaseMessaging _messaging;
  late final FlutterLocalNotificationsPlugin _localNotifications;

  final _messageController = StreamController<RemoteMessage>.broadcast();
  final _tapController = StreamController<PushTap>.broadcast();

  StreamSubscription<RemoteMessage>? _foregroundSub;
  StreamSubscription<RemoteMessage>? _tapSub;
  StreamSubscription<String>? _tokenRefreshSub;

  bool _initialized = false;
  bool _messagingStarted = false;

  /// Stream of messages received while the app is in the foreground.
  @override
  Stream<RemoteMessage> get onMessage => _messageController.stream;

  @override
  Stream<PushTap> get onNotificationTap => _tapController.stream;

  @override
  Future<String?> initialize() async {
    if (_initialized) return await _fetchToken();
    _initialized = true;

    try {
      await _ensureFirebase();

      await _initLocalNotifications();

      final settings = await _messaging.getNotificationSettings();
      if (!_allowed(settings.authorizationStatus)) return null;

      return await _startMessaging();
    } catch (e, stack) {
      _report(e, stack, 'push setup failed');
      rethrow;
    }
  }

  static bool _allowed(AuthorizationStatus status) =>
      status == AuthorizationStatus.authorized || status == AuthorizationStatus.provisional;

  @override
  Future<bool> canRequestPermission() async {
    await _ensureFirebase();
    final settings = await _messaging.getNotificationSettings();
    return switch (settings.authorizationStatus) {
      // iOS, before the prompt has been shown.
      AuthorizationStatus.notDetermined => true,
      // Android 13+ reports a POST_NOTIFICATIONS permission it has never asked for as denied, the
      // same as a refusal, so whether the app has asked is remembered here.
      AuthorizationStatus.denied =>
        defaultTargetPlatform == TargetPlatform.android &&
            !await _storage.containsKey(key: _permissionRequestedKey),
      _ => false,
    };
  }

  @override
  Future<String?> requestPermission() async {
    try {
      await _ensureFirebase();
      await _storage.write(key: _permissionRequestedKey, value: 'true');

      final settings = await _messaging.requestPermission(alert: true, badge: true, sound: true);
      if (!_allowed(settings.authorizationStatus)) return null;

      if (!_initialized) {
        _initialized = true;
        await _initLocalNotifications();
      }
      return await _startMessaging();
    } catch (e, stack) {
      _report(e, stack, 'push permission request failed');
      rethrow;
    }
  }

  /// Listen for messages and token refreshes, register the token, and handle the notification
  /// that launched the app, if any. Runs once permission is granted.
  Future<String?> _startMessaging() async {
    if (_messagingStarted) {
      final token = await _fetchToken();
      if (token != null) await _registerQuietly(token);
      return token;
    }
    _messagingStarted = true;
    // iOS shows a notice that arrives while the app is open as a normal banner. Android does not,
    // which is why _onForegroundMessage posts a local notification there.
    await _messaging.setForegroundNotificationPresentationOptions(
      alert: true,
      badge: true,
      sound: true,
    );
    // `onMessage` / `onMessageOpenedApp` are static on `FirebaseMessaging`; only
    // `onTokenRefresh` is an instance stream.
    _foregroundSub = FirebaseMessaging.onMessage.listen(_onForegroundMessage);
    _tapSub = FirebaseMessaging.onMessageOpenedApp.listen(_onTap);
    _tokenRefreshSub = _messaging.onTokenRefresh.listen(_onTokenRefresh);

    final token = await _fetchToken();
    if (token != null) {
      await _registerQuietly(token);
    }

    final initialMessage = await _messaging.getInitialMessage();
    if (initialMessage != null) {
      _onTap(initialMessage);
    }

    return token;
  }

  /// Manually trigger registration (e.g. after login when the service was
  /// already initialized but had no auth token at the time).
  @override
  Future<void> registerIfAuthenticated() async {
    final String? token;
    try {
      await _ensureFirebase();
      final settings = await _messaging.getNotificationSettings();
      if (!_allowed(settings.authorizationStatus)) {
        throw const PushRegistrationException('notifications are turned off for this app');
      }
      token = await _messaging.getToken();
    } on PushRegistrationException {
      rethrow;
    } catch (e, stack) {
      _report(e, stack, 'FCM token unavailable');
      throw PushRegistrationException('no push token: ${_describe(e)}');
    }
    if (token == null) {
      throw const PushRegistrationException('no push token: Firebase returned none');
    }
    await _registerToken(token);
  }

  @override
  Future<String?> currentToken() async {
    try {
      await _ensureFirebase();
      final settings = await _messaging.getNotificationSettings();
      if (!_allowed(settings.authorizationStatus)) return null;
      return await _messaging.getToken();
    } catch (e) {
      // No Firebase configuration in this build, or (iOS) no APNs token yet.
      debugPrint('[push] FCM token unavailable: ${_describe(e)}');
      return null;
    }
  }

  @override
  Future<void> registerForAccount(String accessToken) async {
    final token = await currentToken();
    if (token != null) {
      await _registerToken(token, bearerToken: accessToken);
    }
  }

  @override
  Future<PushPermission> permissionStatus() async {
    try {
      await _ensureFirebase();
      final settings = await _messaging.getNotificationSettings();
      return switch (settings.authorizationStatus) {
        AuthorizationStatus.authorized || AuthorizationStatus.provisional => PushPermission.granted,
        AuthorizationStatus.notDetermined => PushPermission.notDetermined,
        AuthorizationStatus.denied =>
          await canRequestPermission() ? PushPermission.notDetermined : PushPermission.denied,
      };
    } catch (e, stack) {
      _report(e, stack, 'push permission status unavailable');
      return PushPermission.unavailable;
    }
  }

  static const _systemSettings = MethodChannel('studafy/system_settings');

  @override
  Future<void> openSystemSettings() async {
    if (defaultTargetPlatform == TargetPlatform.android) {
      await _systemSettings.invokeMethod<bool>('openNotificationSettings');
    } else {
      // UIApplication.openSettingsURLString: this app's page in the Settings app.
      await launchUrl(Uri.parse('app-settings:'));
    }
  }

  /// Tear down listeners. Call on logout or app dispose.
  @override
  void dispose() {
    _foregroundSub?.cancel();
    _tapSub?.cancel();
    _tokenRefreshSub?.cancel();
    _messageController.close();
    _tapController.close();
    _dio.close(force: true);
  }

  // -- Internal --------------------------------------------------------------

  Future<void>? _firebaseReady;

  /// Resolves the lazily-initialized Firebase-backed members, once. `Firebase.initializeApp`
  /// returns the existing default app on repeat calls, so both the deferred bootstrap setup and
  /// `initialize()` can trigger it without coordination; the members themselves are `late final`
  /// and must be assigned only the first time.
  Future<void> _ensureFirebase() => _firebaseReady ??= () async {
    await Firebase.initializeApp();
    _messaging = FirebaseMessaging.instance;
    _localNotifications = FlutterLocalNotificationsPlugin();
  }();

  Future<void> _initLocalNotifications() async {
    const androidSettings = AndroidInitializationSettings('@mipmap/ic_launcher');
    // No prompts from this plugin: the app asks through Firebase Messaging, after explaining why.
    const iosSettings = DarwinInitializationSettings(
      requestAlertPermission: false,
      requestBadgePermission: false,
      requestSoundPermission: false,
    );
    const settings = InitializationSettings(android: androidSettings, iOS: iosSettings);

    await _localNotifications.initialize(
      settings,
      onDidReceiveNotificationResponse: (response) {
        final payload = response.payload;
        if (payload != null && payload.isNotEmpty) {
          final data = jsonDecode(payload) as Map<String, dynamic>;
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
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(androidChannel);
  }

  void _onForegroundMessage(RemoteMessage message) {
    _messageController.add(message);

    // iOS already shows the banner (setForegroundNotificationPresentationOptions); a local copy
    // there would show it twice.
    if (defaultTargetPlatform != TargetPlatform.android) return;
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
    final route = resolveNotificationTapRoute(data);
    if (route != null) {
      final userId = data['user_id'];
      _tapController.add(
        PushTap(route, userId: userId is String && userId.isNotEmpty ? userId : null),
      );
    }
  }

  Future<void> _onTokenRefresh(String token) async {
    await _registerQuietly(token);
  }

  /// This phone's FCM token, or null when Firebase could not issue one. The failure (on Android
  /// typically a Firebase configuration or API-key problem: `FIS_AUTH_ERROR`,
  /// `SERVICE_NOT_AVAILABLE`) is reported rather than thrown, so setup still finishes.
  Future<String?> _fetchToken() async {
    try {
      return await _messaging.getToken();
    } catch (e, stack) {
      _report(e, stack, 'FCM token unavailable');
      return null;
    }
  }

  /// [_registerToken] for background paths (setup, token refresh): the failure is already
  /// reported, and nothing is waiting on the result.
  Future<void> _registerQuietly(String fcmToken) async {
    try {
      await _registerToken(fcmToken);
    } on PushRegistrationException {
      // Reported in _registerToken.
    }
  }

  /// Logs (logcat / Xcode console, tag `flutter`, prefix `[push]`) and forwards to crash reporting.
  void _report(Object error, StackTrace stack, String reason) {
    debugPrint('[push] $reason: ${_describe(error)}');
    try {
      _onError?.call(error, stack, reason);
    } catch (_) {
      // Reporting is best-effort.
    }
  }

  /// A short description of a push failure that never includes a token or header.
  static String _describe(Object error) => switch (error) {
    DioException(:final response?) => 'HTTP ${response.statusCode}',
    DioException(:final type) => 'network error (${type.name})',
    FirebaseException(:final code, :final message) => message == null ? code : '$code: $message',
    PlatformException(:final code, :final message) => message == null ? code : '$code: $message',
    _ => error.runtimeType.toString(),
  };

  /// Registers [fcmToken] for the active account (or [bearerToken]'s). Throws
  /// [PushRegistrationException] — after reporting it — when the API refuses or can't be reached.
  /// Signed out (no bearer token) is not a failure: there is no one to register for.
  Future<void> _registerToken(String fcmToken, {String? bearerToken}) async {
    bearerToken ??= await _getToken();
    if (bearerToken == null) return;

    final platform = defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android';

    try {
      await _dio.post(
        '/api/auth/devices',
        // Every account signed in on this phone keeps receiving its notices; each one removes its
        // own registration when it signs out (fcm_token on POST /api/auth/logout).
        data: {'fcm_token': fcmToken, 'platform': platform, 'keep_other_accounts': true},
        options: Options(headers: {'Authorization': 'Bearer $bearerToken'}),
      );
    } catch (e, stack) {
      _report(e, stack, 'push token registration failed');
      throw PushRegistrationException('the server did not accept this phone: ${_describe(e)}');
    }
  }
}
