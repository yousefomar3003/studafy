import 'package:easy_localization/easy_localization.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/date_symbol_data_local.dart';

import '../../app.dart';
import '../auth/auth_notifier.dart';
import '../auth/auth_session.dart';
import '../auth/oauth_client.dart';
import '../auth/secure_token_store.dart';
import '../di/app_providers.dart';
import '../localization/app_locales.dart';
import '../push/push_providers.dart';
import '../realtime/realtime_providers.dart';
import 'app_config.dart';
import 'app_environment.dart';

void bootstrapApp(AppEnvironment environment) async {
  WidgetsFlutterBinding.ensureInitialized();
  await EasyLocalization.ensureInitialized();

  // `easy_localization` loads translation strings but never calls `intl`'s own
  // `initializeDateFormatting` — any `DateFormat` built before this (e.g. the due date on
  // `TodayAssignmentsCard`'s rows) throws `LocaleDataException` instead of formatting. One call
  // per supported locale, done once here rather than per call site.
  for (final locale in AppLocales.supported) {
    await initializeDateFormatting(locale.toString());
  }

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
    EasyLocalization(
      supportedLocales: AppLocales.supported,
      path: AppLocales.translationsPath,
      fallbackLocale: AppLocales.fallback,
      child: ProviderScope(
        overrides: [
          appConfigProvider.overrideWithValue(appConfig),
          authSessionProvider.overrideWithValue(session),
          realtimeTokenProvider.overrideWithValue(
            () => session.tokenProvider,
          ),
        ],
        child: const StudafyApp(),
      ),
    ),
  );
}
