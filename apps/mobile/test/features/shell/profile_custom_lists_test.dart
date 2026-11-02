import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/shell/presentation/pill_navigation_bar.dart';

import '../../support/pump_app_shell.dart';
import '../../support/pump_studafy_app.dart';

/// "Lists" on the Profile tab: offered to every member of staff (customList:use; which lists they
/// then read is up to each list's audience), and to no student, parent or support agent.
void main() {
  for (final roles in const [
    ['INSTRUCTOR'],
    ['ATTENDANCE_OFFICER'],
    ['FINANCE'],
    ['ORG_ADMIN'],
  ]) {
    testWidgets('${roles.first} sees "Lists"', (tester) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: roles),
      );
      await _openProfile(tester);
      expect(find.byKey(const Key('profileCustomLists')), findsOneWidget);
    });
  }

  for (final roles in const [
    ['STUDENT'],
    ['PARENT'],
    ['SUPPORT_AGENT'],
  ]) {
    testWidgets('${roles.first} does not', (tester) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: roles),
      );
      await _openProfile(tester);
      expect(find.byKey(const Key('profileCustomLists')), findsNothing);
    });
  }
}

Future<void> _openProfile(WidgetTester tester) async {
  await tester.tap(
    find.descendant(
      of: find.byType(PillNavigationBar),
      matching: find.byIcon(Icons.person_outline),
    ),
  );
  await tester.pumpAndSettle();
}
