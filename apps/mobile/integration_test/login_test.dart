import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/features/shell/presentation/app_shell.dart';

import 'support/personas.dart';
import 'support/test_app.dart';

/// Journey 1/5 (ST-247): login.
///
/// Real device, real backend, real mock-OAuth PKCE round trip: the app opens on the login screen
/// unauthenticated, "Continue with Mock" drives the actual `AuthNotifier.login('mock')` flow
/// against the real API (only the system-browser hop is swapped for `FakeOAuthBrowser` — see that
/// class's doc comment for why an instrumented test cannot drive `ASWebAuthenticationSession`/
/// Custom Tabs chrome), and the router's real `authGuard` redirect lands on the real [AppShell].
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('signs in via the real mock OAuth round trip and lands on the app shell', (
    tester,
  ) async {
    final app = await IntegrationTestApp.pump(tester, mockLoginHint: Personas.orgAdmin);

    expect(find.byType(AppShell), findsNothing);
    expect(app.container.read(authStatusProvider), AuthStatus.unauthenticated);

    await app.signInWithMock(tester);

    expect(app.container.read(authStatusProvider), AuthStatus.authenticated);
    expect(find.byType(AppShell), findsOneWidget);
  });
}
