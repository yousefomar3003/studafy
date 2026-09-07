import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/update/forced_update_screen.dart';
import 'package:studafy_mobile/src/core/update/update_providers.dart';
import 'package:studafy_mobile/src/core/update/update_status.dart';

import '../../support/pump_studafy_app.dart';

/// Boots the real app — router redirect wired as production does — and verifies the forced-update
/// branch wins over the auth guard: an `updateRequired` decision pins the app to
/// [ForcedUpdateScreen] even for an already-authenticated session.
///
/// One `testWidgets` per file on purpose: constructing a second real `GoRouter` in the same
/// process hits the `go_router`/`flutter_test` initial-route quirk `auth_guard_boot_test.dart`
/// documents. The unblocked path is covered by `widget_test.dart` (which pumps with the default,
/// un-overridden `updateStatusProvider` — fail-open — and still reaches the login screen).
void main() {
  testWidgets('updateRequired pins an authenticated session to the forced-update screen', (
    tester,
  ) async {
    await pumpStudafyApp(
      tester,
      session: await fakeAuthenticatedSession(roles: const ['STUDENT']),
      extraOverrides: [
        updateStatusProvider.overrideWith((ref) async => UpdateStatus.updateRequired),
      ],
    );

    expect(find.byType(ForcedUpdateScreen), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
  });
}
