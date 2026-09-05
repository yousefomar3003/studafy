import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/app.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/config/app_config.dart';
import 'package:studafy_mobile/src/core/config/app_environment.dart';
import 'package:studafy_mobile/src/core/di/app_providers.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/core/monitoring/monitoring_providers.dart';
import 'package:studafy_mobile/src/core/push/push_providers.dart';
import 'package:studafy_mobile/src/core/realtime/realtime_providers.dart';

import '../../test/support/fake_crash_reporter.dart';
import '../../test/support/fake_push_service.dart';
import 'fake_oauth_browser.dart';

/// The [AppConfig] this run targets, built from the same `--dart-define`s `main_dev.dart` reads
/// (`API_BASE_URL`, `REALTIME_BASE_URL`, `WEB_BASE_URL`) — see
/// docs/testing/mobile-integration-suite.md for how CI/local runs supply these. `AppEnvironment.dev`
/// both matches those loopback-friendly defaults and is what gates the "Continue with Mock" button
/// visible (`LoginScreen`'s `showMockLogin`).
AppConfig integrationTestAppConfig() => AppConfig.fromEnvironment(AppEnvironment.dev);

/// Pumps the real [StudafyApp] — router, auth guard, theme, localization, all wired exactly as
/// `bootstrapApp` does — against a real device/emulator's real network, real secure storage
/// (`authSessionProvider`'s default provider body, left un-overridden), and a real mock-OAuth
/// round trip (`FakeOAuthBrowser`, which itself talks to the real backend). Only three seams are
/// swapped, all at the same `ProviderScope.overrides` points the widget-test suite already uses
/// for the same reason: [FakeCrashReporter] and [FakePushService] stand in for real Sentry/
/// Crashlytics/FCM (no vendor project configured for CI-run devices), and [FakeOAuthBrowser]
/// stands in for launching a system browser (see that class's own doc comment).
class IntegrationTestApp {
  IntegrationTestApp._(this.container, this.appConfig, this._extraOverrides, this.pushService);

  final ProviderContainer container;
  AppConfig appConfig;

  // Untyped: riverpod 3.3.2's `flutter_riverpod.dart` barrel doesn't export the `Override` type
  // `ProviderContainer.overrides`/`updateOverrides` are themselves typed with — see the identical
  // note on `test/features/student/presentation/today_screen_test.dart`'s `_pumpTodayScreen`. That
  // file sidesteps it by never factoring out a reusable helper; this one still wants
  // `setApiBaseUrl` to rebuild the same extra overrides a test passed to [pump], so the list is
  // carried as `dynamic` instead — its elements are never anything but `Override`s in practice.
  final dynamic _extraOverrides;

  /// The [FakePushService] instance backing `pushServiceProvider` for this run — exposed so a
  /// journey with no other in-app deep-link trigger (`ai_upsell_deep_link_test.dart`'s return
  /// trip) can call [FakePushService.simulateNotificationTap], exactly the seam
  /// [FirebasePushService] itself feeds from a real tap.
  final FakePushService pushService;

  /// [extraOverrides] is for provider seams a specific journey needs beyond the baseline every
  /// journey shares — e.g. `ai_upsell_deep_link_test.dart` overriding `currentStudentIdProvider`
  /// (a documented, test-sanctioned gap — see that provider's own doc comment) to reach the
  /// upsell state at all.
  static Future<IntegrationTestApp> pump(
    WidgetTester tester, {
    String? mockLoginHint,
    // See the comment on `_extraOverrides` above for why this can't be typed `List<Override>`.
    dynamic extraOverrides = const <Never>[],
  }) async {
    await EasyLocalization.ensureInitialized();
    final appConfig = integrationTestAppConfig();
    final pushService = FakePushService();
    addTearDown(pushService.dispose);

    final container = ProviderContainer(
      overrides: [
        ..._baselineOverrides(
          appConfig: appConfig,
          mockLoginHint: mockLoginHint,
          pushService: pushService,
        ),
        ...extraOverrides,
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: EasyLocalization(
          supportedLocales: AppLocales.supported,
          path: AppLocales.translationsPath,
          fallbackLocale: AppLocales.fallback,
          child: const StudafyApp(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    return IntegrationTestApp._(container, appConfig, extraOverrides, pushService);
  }

  static List<dynamic> _baselineOverrides({
    required AppConfig appConfig,
    required String? mockLoginHint,
    required FakePushService pushService,
  }) {
    return [
      appConfigProvider.overrideWithValue(appConfig),
      oAuthBrowserProvider.overrideWith((ref) => FakeOAuthBrowser()),
      crashReporterProvider.overrideWithValue(FakeCrashReporter()),
      pushServiceProvider.overrideWithValue(pushService),
      mockLoginHintProvider.overrideWithValue(mockLoginHint),
      // Mirrors `bootstrapApp`'s own override — see `realtime_providers.dart`'s doc comment for
      // why this seam exists at all (no session/auth feature existed when it was written).
      realtimeTokenProvider.overrideWith(
        (ref) => () => ref.watch(authSessionProvider).tokenProvider,
      ),
    ];
  }

  /// Re-points [appConfig] at [apiBaseUrl] without tearing the widget tree down —
  /// `attendance_offline_replay_test.dart`'s "airplane mode": every provider downstream of
  /// `appConfigProvider` (`networkConfigProvider`, `apiClientProvider`,
  /// `attendanceSyncQueueProvider`, ...) rebuilds against the new URL because they `ref.watch` it,
  /// the same propagation a real config change would trigger. A DioException against an
  /// unroutable host is a real network failure, not a stubbed response — only the "how" of going
  /// offline (repointing DNS/routing vs. an OS airplane-mode toggle no instrumented test can
  /// reach) is different from a physical device.
  void setApiBaseUrl(Uri apiBaseUrl) {
    appConfig = appConfig.copyWith(apiBaseUrl: apiBaseUrl);
    container.updateOverrides([
      ..._baselineOverrides(
        appConfig: appConfig,
        mockLoginHint: container.read(mockLoginHintProvider),
        pushService: pushService,
      ),
      ..._extraOverrides,
    ]);
  }

  /// Taps the dev-only "Continue with Mock" button (visible because [appConfig]'s environment is
  /// [AppEnvironment.dev] — see `LoginScreen`) and waits for the router to land past it.
  Future<void> signInWithMock(WidgetTester tester) async {
    final button = find.byKey(const Key('mockLoginButton'));
    expect(
      button,
      findsOneWidget,
      reason: 'mock login button not found — not on the login screen, or not AppEnvironment.dev',
    );
    await tester.tap(button);
    // The mock round trip is a handful of real HTTP calls; pumpAndSettle alone can time out
    // waiting on network I/O between frames, so poll explicitly instead.
    await pumpUntil(tester, () => find.byKey(const Key('mockLoginButton')).evaluate().isEmpty);
    await tester.pumpAndSettle();
  }
}

/// Pumps frames until [condition] is true or [timeout] elapses, for waiting out real async work
/// (network calls, realtime handshakes) that `pumpAndSettle` alone isn't reliable for. Shared by
/// [IntegrationTestApp.signInWithMock] and any test file waiting on its own condition (e.g.
/// `attendance_offline_replay_test.dart` polling the outbox).
Future<void> pumpUntil(
  WidgetTester tester,
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 15),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      throw TimeoutException('condition not met within $timeout');
    }
    await tester.pump(const Duration(milliseconds: 100));
  }
}
