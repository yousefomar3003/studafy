import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/shell/presentation/pill_navigation_bar.dart';

import '../../support/pump_app_shell.dart';
import '../../support/pump_studafy_app.dart';

/// "Switch account" → "Add account", through the real app (router + auth guard): the active
/// account is set aside, still signed in, and listed on the login screen to come back to.
///
/// Only one test here pumps the real router: see auth_guard_boot_test.dart for why a second
/// `GoRouter` per test process is unreliable.
void main() {
  testWidgets('adding an account keeps the current one on the login screen', (
    tester,
  ) async {
    await pumpStudafyApp(
      tester,
      session: await fakeAuthenticatedSession(
        // The viewer shell: its Home tab touches no offline storage.
        roles: const ['ORG_ADMIN'],
        userId: 'admin-a',
      ),
    );

    await tester.tap(
      find.descendant(
        of: find.byType(PillNavigationBar),
        matching: find.byIcon(Icons.person_outline),
      ),
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('profileSwitchAccount')));
    await tester.tap(find.byKey(const Key('profileSwitchAccount')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('accountSwitcherCurrent')), findsOneWidget);
    await tester.tap(find.byKey(const Key('accountSwitcherAdd')));
    await tester.pumpAndSettle();

    expect(find.byType(PillNavigationBar), findsNothing);
    expect(find.byKey(const Key('brandLogo')), findsOneWidget);
    expect(find.text('Accounts on this phone'), findsOneWidget);
    expect(find.byKey(const Key('savedAccount-admin-a')), findsOneWidget);
    expect(find.byKey(const Key('memberSignInUsername')), findsOneWidget);
  });

  testWidgets(
    'a student can open the switcher to add a parent or sibling account',
    (tester) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: const ['STUDENT']),
      );

      await tester.tap(
        find.descendant(
          of: find.byType(PillNavigationBar),
          matching: find.byIcon(Icons.person_outline),
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('profileSwitchAccount')));
      await tester.tap(find.byKey(const Key('profileSwitchAccount')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('accountSwitcherCurrent')), findsOneWidget);
      expect(find.byKey(const Key('accountSwitcherAdd')), findsOneWidget);
    },
  );
}
