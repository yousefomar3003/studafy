import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/features/shell/presentation/app_shell.dart';

import 'support/api_helpers.dart';
import 'support/personas.dart';
import 'support/test_app.dart';

/// Journey 2/5 (ST-247): invitation activation.
///
/// There is no invitation-activation screen anywhere in the Flutter app yet — `MobileAuthClient`
/// carries the `startInvitationOAuth`/`exchangeInvitationCode` HTTP methods
/// (`core/auth/oauth_client.dart`) and `InvitationActivationResult` documents the outcomes an
/// `AuthNotifier.activateInvitation` would return, but no such method, screen, or deep-link route
/// exists to call them — see docs/testing/mobile-integration-suite.md's journey table for why this
/// is an honest gap, not this test cutting a corner. This journey therefore proves the real backend
/// contract end-to-end via the API (the same one that screen would call once built:
/// `/oauth/mock/mobile-start` → `/mobile-exchange`, ST-247's new mock-provider mobile activation
/// routes), then signs the freshly-activated account into the real app to prove the account it
/// created is genuinely usable — not just that a 200 came back.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'activates a new admin via the mock OAuth mobile round trip, then signs them into the app',
    (tester) async {
      final appConfig = integrationTestAppConfig();
      final dio = Dio(BaseOptions(baseUrl: appConfig.apiBaseUrl.toString()));

      final adminToken = await apiLoginAs(dio, Personas.orgAdmin);
      final inviteeEmail =
          'new-admin+${DateTime.now().microsecondsSinceEpoch}@e2e-academy.test';

      final token = await createInvitation(
        dio,
        adminToken: adminToken,
        email: inviteeEmail,
        role: 'ORG_ADMIN',
      );
      expect(token, matches(RegExp(r'^[0-9a-f]{64}$')));

      final beforeActivation = await verifyInvitation(dio, token);
      expect(beforeActivation.statusCode, 200);

      final activation = await activateInvitationViaMock(dio, token: token, email: inviteeEmail);
      expect(activation['status'], 'active');
      expect(activation['access_token'], isA<String>());

      // The invitation is now consumed — re-verifying it must report CONSUMED, the honest proof
      // the activation transaction actually committed (mirrors
      // apps/web/e2e/critical/invitation-activation.spec.ts's identical final check).
      final afterActivation = await verifyInvitation(dio, token);
      expect(afterActivation.statusCode, 409);
      expect(afterActivation.data!['code'], 'CONSUMED');

      // Prove the account this just created is real: sign into the actual app as it.
      final app = await IntegrationTestApp.pump(tester, mockLoginHint: inviteeEmail);
      await app.signInWithMock(tester);

      expect(app.container.read(authStatusProvider), AuthStatus.authenticated);
      expect(find.byType(AppShell), findsOneWidget);
    },
  );
}
