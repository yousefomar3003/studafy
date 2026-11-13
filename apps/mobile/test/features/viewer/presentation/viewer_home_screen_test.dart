import 'package:flutter_test/flutter_test.dart';

import '../../../support/pump_app_shell.dart';
import '../../../support/pump_studafy_app.dart';

/// Each role's Home tab shows its own summary — not just that it landed in the viewer shell at
/// all (that's `app_shell_test.dart`'s job). Endpoints are unmocked here (same as every other
/// role's home screen in this test file's siblings), so every card renders its error state; this
/// only asserts *which* cards are on screen, i.e. which summary was picked.
void main() {
  testWidgets('org admin sees the admin summary cards', (tester) async {
    await pumpAppShell(tester, session: await fakeAuthenticatedSession(roles: const ['ORG_ADMIN']));

    expect(find.text('Attendance this term'), findsOneWidget);
    expect(find.text('Open discipline incidents'), findsOneWidget);
    expect(find.text('Draft evaluations'), findsOneWidget);
    expect(find.text('Recent announcements'), findsOneWidget);
    expect(find.text('Recent payments'), findsNothing);
  });

  testWidgets('super admin sees the admin summary cards too', (tester) async {
    await pumpAppShell(
      tester,
      session: await fakeAuthenticatedSession(roles: const ['SUPER_ADMIN']),
    );

    expect(find.text('Attendance this term'), findsOneWidget);
  });

  testWidgets('finance sees the finance summary card, not the admin ones', (tester) async {
    await pumpAppShell(tester, session: await fakeAuthenticatedSession(roles: const ['FINANCE']));

    expect(find.text('Recent payments'), findsOneWidget);
    expect(find.text('Attendance this term'), findsNothing);
    expect(find.text('Open discipline incidents'), findsNothing);
  });

  testWidgets('support agent sees the generic placeholder, not a summary', (tester) async {
    await pumpAppShell(
      tester,
      session: await fakeAuthenticatedSession(roles: const ['SUPPORT_AGENT']),
    );

    // The Profile tab is also a `ShellTabPlaceholder` sharing this same body text, but finders
    // skip offstage content by default and only the Home tab is the active `IndexedStack` index.
    expect(find.text('This section is coming soon.'), findsOneWidget);
    expect(find.text('Attendance this term'), findsNothing);
    expect(find.text('Recent payments'), findsNothing);
  });
}
