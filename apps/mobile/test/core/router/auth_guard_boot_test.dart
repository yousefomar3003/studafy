import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/pump_studafy_app.dart';

/// Boots the real app — router, auth guard, and shell all wired exactly as production does —
/// for an already-authenticated session, verifying `authGuard` redirects away from `/login`
/// once `AuthNotifier` resolves to `AuthStatus.authenticated`.
///
/// Kept in its own file/process: constructing a second real `GoRouter` in the same test file
/// as `widget_test.dart`'s unauthenticated-boot test hits a `go_router`/`flutter_test`
/// limitation where only the first `GoRouter` per process reliably receives its initial route
/// resolution — a test-harness quirk, not a production concern, since `bootstrapApp` only ever
/// constructs one `GoRouter` for the app's entire lifetime.
void main() {
  testWidgets('authenticated session redirects off /login onto the app shell', (tester) async {
    await pumpStudafyApp(
      tester,
      session: await fakeAuthenticatedSession(roles: const ['STUDENT']),
    );

    expect(find.byType(NavigationBar), findsOneWidget);
    expect(find.text('Sign in with Microsoft'), findsNothing);
  });
}
