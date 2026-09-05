import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:studafy_mobile/src/features/ai/presentation/ai_usage_screen.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';
import 'package:url_launcher_platform_interface/url_launcher_platform_interface.dart';

import 'support/api_helpers.dart';
import 'support/fake_url_launcher.dart';
import 'support/personas.dart';
import 'support/test_app.dart';

/// Journey 5/5 (ST-247): AI upsell deep-link round trip.
///
/// Outbound half is fully real: the real [AiUpsellCard] on the real AI tab, its real
/// `aiCheckoutUrlProvider`, a real tap through to the platform's `launchUrl` seam (swapped for
/// [FakeUrlLauncher] so no actual browser opens mid-suite — see that class's doc comment; this is
/// the same platform-interface substitution the `url_launcher` package's own tests use, not a
/// stub of app code). `currentStudentIdProvider` is overridden to the real resolved id: it always
/// resolves to `null` in production today (`core/api` has no self-resolving `/students/me`
/// endpoint — a documented, currently-unfillable gap whose own doc comment explicitly invites
/// "override... in tests", unlike a bug this suite would be wrong to paper over).
///
/// Return half: there is no real "purchase completed" deep link in this app yet — the checkout
/// page lives entirely in `apps/web` and nothing calls back into the mobile app when it finishes
/// (see docs/testing/mobile-integration-suite.md's journey table). The one real return-trip
/// mechanism this app has for *any* out-of-app event is a push-notification tap
/// (`PushService.onNotificationTap` → `StudafyApp`'s `GoRouter.push`), so this half proves that
/// exact mechanism lands on the AI usage screen, standing in for "a completed-purchase
/// notification arrives and deep-links back in".
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'launches the real checkout URL, then a notification tap deep-links back into the app',
    (tester) async {
      final urlLauncher = FakeUrlLauncher();
      UrlLauncherPlatform.instance = urlLauncher;

      final appConfig = integrationTestAppConfig();
      final dio = Dio(BaseOptions(baseUrl: appConfig.apiBaseUrl.toString()));
      final adminToken = await apiLoginAs(dio, Personas.orgAdmin);
      final studentId = await findStudentIdByName(
        dio,
        adminToken: adminToken,
        firstName: 'Lina',
        lastName: 'Haddad',
      );

      final app = await IntegrationTestApp.pump(
        tester,
        mockLoginHint: Personas.unsubscribedAiStudent,
        extraOverrides: [currentStudentIdProvider.overrideWithValue(studentId)],
      );
      await app.signInWithMock(tester);

      await tester.tap(find.text('AI'));
      await pumpUntil(tester, () => find.text('Continue on the website').evaluate().isNotEmpty);

      await tester.tap(find.text('Continue on the website'));
      await tester.pumpAndSettle();

      expect(urlLauncher.launches, hasLength(1));
      final launched = Uri.parse(urlLauncher.launches.single);
      expect(launched.path, '/account/ai');
      expect(launched.queryParameters['studentId'], studentId);
      expect(
        launched.queryParameters['priceId'],
        isNotEmpty,
        reason: 'AI_ADDON_PRICE_ID must be supplied via --dart-define for this journey to be '
            'meaningful — see docs/testing/mobile-integration-suite.md',
      );

      // Round trip: simulate the notification tap a completed purchase would deliver.
      app.pushService.simulateNotificationTap('/me/ai/usage');
      await tester.pumpAndSettle();

      expect(find.byType(AiUsageScreen), findsOneWidget);
    },
  );
}
