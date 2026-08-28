import 'dart:async';
import 'dart:ui';

import 'package:easy_localization/easy_localization.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../app.dart';
import '../auth/auth_notifier.dart';
import '../auth/auth_session.dart';
import '../auth/oauth_client.dart';
import '../auth/secure_token_store.dart';
import '../di/app_providers.dart';
import '../localization/app_locales.dart';
import '../monitoring/composite_crash_reporter.dart';
import '../monitoring/crash_reporter.dart';
import '../monitoring/crashlytics_reporter.dart';
import '../monitoring/monitoring_config.dart';
import '../monitoring/monitoring_providers.dart';
import '../monitoring/sentry_reporter.dart';
import '../push/push_providers.dart';
import '../realtime/realtime_providers.dart';
import 'app_config.dart';
import 'app_environment.dart';

void bootstrapApp(AppEnvironment environment) {
  CrashReporter? crashReporter;

  runZonedGuarded<Future<void>>(() async {
    WidgetsFlutterBinding.ensureInitialized();
    await EasyLocalization.ensureInitialized();

    for (final locale in AppLocales.supported) {
      await initializeDateFormatting(locale.toString());
    }

    GoogleFonts.config.allowRuntimeFetching = false;

    await Firebase.initializeApp();
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);

    final appConfig = AppConfig.fromEnvironment(environment);
    final packageInfo = await PackageInfo.fromPlatform();
    final monitoringConfig = MonitoringConfig.fromEnvironment(
      environment,
      release:
          '${packageInfo.packageName}@${packageInfo.version}+${packageInfo.buildNumber}',
    );
    crashReporter = CompositeCrashReporter([
      SentryCrashReporter(monitoringConfig),
      FirebaseCrashlyticsReporter(),
    ]);
    await crashReporter!.initialize();

    FlutterError.onError = (details) {
      FlutterError.presentError(details);
      crashReporter?.recordFlutterError(details);
    };
    PlatformDispatcher.instance.onError = (error, stack) {
      crashReporter?.recordError(error, stack, fatal: true);
      return true;
    };

    final authClient = MobileAuthClient(
      baseUrl: appConfig.apiBaseUrl.toString(),
    );
    final secureStore = SecureTokenStore();
    final session = AuthSession(
      authClient: authClient,
      secureStore: secureStore,
    );
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
            crashReporterProvider.overrideWithValue(crashReporter!),
            realtimeTokenProvider.overrideWithValue(
              () => session.tokenProvider,
            ),
          ],
          child: const StudafyApp(),
        ),
      ),
    );
  }, (error, stack) => crashReporter?.recordError(error, stack, fatal: true));
}
