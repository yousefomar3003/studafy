import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../app.dart';
import '../auth/auth_notifier.dart';
import '../auth/auth_session.dart';
import '../auth/oauth_client.dart';
import '../auth/secure_token_store.dart';
import '../di/app_providers.dart';
import '../push/push_providers.dart';
import '../realtime/realtime_providers.dart';
import 'app_config.dart';
import 'app_environment.dart';

void bootstrapApp(AppEnvironment environment) async {
  WidgetsFlutterBinding.ensureInitialized();

  GoogleFonts.config.allowRuntimeFetching = false;

  // Firebase must be initialized before runApp() so the background message
  // handler is registered and FCM token acquisition can start immediately.
  await Firebase.initializeApp();
  FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);

  final appConfig = AppConfig.fromEnvironment(environment);

  final authClient = MobileAuthClient(baseUrl: appConfig.apiBaseUrl.toString());
  final secureStore = SecureTokenStore();
  final session = AuthSession(authClient: authClient, secureStore: secureStore);
  await session.restore();

  runApp(
    ProviderScope(
      overrides: [
        appConfigProvider.overrideWithValue(appConfig),
        authSessionProvider.overrideWithValue(session),
        realtimeTokenProvider.overrideWithValue(
          () => session.tokenProvider,
        ),
      ],
      child: const StudafyApp(),
    ),
  );
}
