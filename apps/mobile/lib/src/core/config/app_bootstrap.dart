import 'dart:async';
import 'dart:ui';

import 'package:easy_localization/easy_localization.dart';
import 'package:firebase_core/firebase_core.dart';
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
  // Monitoring is set up inside this same guarded zone so both the zone's own error handler and
  // the crash reporter it builds agree on what "an uncaught error" means. `crashReporter` is
  // read by the zone's `onError` below, which — being a sibling of the zoned callback rather than
  // nested inside it — can only see it via this shared, mutable outer variable.
  CrashReporter? crashReporter;

  runZonedGuarded<Future<void>>(
    () async {
      WidgetsFlutterBinding.ensureInitialized();
      await EasyLocalization.ensureInitialized();

      // `easy_localization` loads translation strings but never calls `intl`'s own
      // `initializeDateFormatting` — any `DateFormat` built before this (e.g. the due date on
      // `TodayAssignmentsCard`'s rows) throws `LocaleDataException` instead of formatting. One
      // call per supported locale, done once here rather than per call site.
      for (final locale in AppLocales.supported) {
        await initializeDateFormatting(locale.toString());
      }

      GoogleFonts.config.allowRuntimeFetching = false;

      final appConfig = AppConfig.fromEnvironment(environment);

      final packageInfo = await PackageInfo.fromPlatform();
      final monitoringConfig = MonitoringConfig.fromEnvironment(
        environment,
        release: '${packageInfo.packageName}@${packageInfo.version}+${packageInfo.buildNumber}',
      );
      crashReporter = CompositeCrashReporter([
        SentryCrashReporter(monitoringConfig),
        FirebaseCrashlyticsReporter(),
      ]);

      FlutterError.onError = (details) {
        FlutterError.presentError(details);
        crashReporter?.recordFlutterError(details);
      };
      PlatformDispatcher.instance.onError = (error, stack) {
        crashReporter?.recordError(error, stack, fatal: true);
        return true;
      };

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
              crashReporterProvider.overrideWithValue(crashReporter!),
              realtimeTokenProvider.overrideWithValue(
                () => session.tokenProvider,
              ),
            ],
            child: const StudafyApp(),
          ),
        ),
      );

      // Deferred init — see docs/perf-test-protocol.md. Firebase app setup and both crash
      // reporters' initialization (Sentry's `SentryFlutter.init` is the slowest single bootstrap
      // step) are not needed to draw the first frame, so they run after it instead of blocking
      // the cold-start critical path. `FirebasePushService.initialize()` also awaits
      // `Firebase.initializeApp()` itself, so push registration (post-auth) cannot race this.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        unawaited(_deferredSetup(crashReporter!));
      });
    },
    (error, stack) {
      // Catches errors thrown outside any Flutter-owned callback (e.g. from a raw Future chain).
      // `crashReporter` is null only if this fires during the setup above, before it's built —
      // there's nowhere to report those to, so they're limited to bootstrap itself.
      crashReporter?.recordError(error, stack, fatal: true);
    },
  );
}

/// The post-first-frame half of startup: the work that can wait a frame so the app renders
/// sooner. Dispatched from [bootstrapApp] once the first frame has been drawn.
Future<void> _deferredSetup(CrashReporter crashReporter) async {
  // Registering the background handler is a cheap static wiring call, but it needs the Firebase
  // default app up first. A notification arriving in the brief pre-Firebase window is still
  // displayed by the OS (the pushed payload always carries notification fields); only a tap in
  // that sub-second gap would not reach the Dart handler — acceptable and documented.
  await Firebase.initializeApp();
  FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);

  await crashReporter.initialize();
}
