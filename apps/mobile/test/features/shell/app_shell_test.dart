import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/pump_app_shell.dart';
import '../../support/pump_studafy_app.dart';

void main() {
  group('lands each role in its own shell', () {
    testWidgets('student gets Home, Timetable, Courses, AI, Profile — and a mutation FAB', (
      tester,
    ) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: const ['STUDENT']),
      );

      expect(find.text('Home'), findsWidgets);
      expect(find.text('Timetable'), findsWidgets);
      expect(find.text('Courses'), findsWidgets);
      expect(find.text('AI'), findsWidgets);
      expect(find.text('Profile'), findsWidgets);
      expect(find.byType(FloatingActionButton), findsOneWidget);
    });

    testWidgets('instructor gets Home, Classes, Profile — and a mutation FAB', (tester) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: const ['INSTRUCTOR']),
      );

      expect(find.text('Home'), findsWidgets);
      expect(find.text('Classes'), findsWidgets);
      expect(find.text('Profile'), findsWidgets);
      expect(find.byType(FloatingActionButton), findsOneWidget);
    });

    testWidgets('teaching assistant also gets the teacher shell', (tester) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: const ['TEACHING_ASSISTANT']),
      );

      expect(find.text('Classes'), findsWidgets);
    });

    testWidgets('parent gets Home, Children, Profile — and a mutation FAB', (tester) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: const ['PARENT']),
      );

      expect(find.text('Home'), findsWidgets);
      expect(find.text('Children'), findsWidgets);
      expect(find.text('Profile'), findsWidgets);
      expect(find.byType(FloatingActionButton), findsOneWidget);
    });
  });

  group('admin-type and guest roles land in the read-only viewer shell', () {
    Future<void> expectViewerShell(WidgetTester tester, List<String> roles) async {
      await pumpAppShell(tester, session: await fakeAuthenticatedSession(roles: roles));

      expect(find.text('Home'), findsWidgets);
      expect(find.text('Profile'), findsWidgets);
      // No domain-specific tab, and zero mutation affordances.
      expect(find.text('Timetable'), findsNothing);
      expect(find.text('Courses'), findsNothing);
      expect(find.text('AI'), findsNothing);
      expect(find.text('Classes'), findsNothing);
      expect(find.text('Children'), findsNothing);
      expect(find.byType(FloatingActionButton), findsNothing);
      expect(find.textContaining('View only'), findsOneWidget);
    }

    testWidgets('org admin', (tester) async {
      await expectViewerShell(tester, const ['ORG_ADMIN']);
    });

    testWidgets('super admin', (tester) async {
      await expectViewerShell(tester, const ['SUPER_ADMIN']);
    });

    testWidgets('finance', (tester) async {
      await expectViewerShell(tester, const ['FINANCE']);
    });

    testWidgets('support agent', (tester) async {
      await expectViewerShell(tester, const ['SUPPORT_AGENT']);
    });

    testWidgets('guest', (tester) async {
      await expectViewerShell(tester, const ['GUEST']);
    });

    testWidgets('an admin role alongside a teaching role still stays view-only', (tester) async {
      // Admin-type roles always win: mobile is never the admin console, even for a session
      // that also happens to teach.
      await expectViewerShell(tester, const ['ORG_ADMIN', 'INSTRUCTOR']);
    });
  });

  testWidgets('tapping a destination switches the visible tab without losing the others',
      (tester) async {
    await pumpAppShell(
      tester,
      session: await fakeAuthenticatedSession(roles: const ['STUDENT']),
    );

    IndexedStack stack() => tester.widget(find.byType(IndexedStack));
    NavigationBar navBar() => tester.widget(find.byType(NavigationBar));
    Finder navLabel(String text) =>
        find.descendant(of: find.byType(NavigationBar), matching: find.text(text));

    expect(stack().index, 0);
    expect(navBar().selectedIndex, 0);

    await tester.tap(navLabel('Timetable'));
    await tester.pumpAndSettle();

    expect(stack().index, 1);
    expect(navBar().selectedIndex, 1);

    // IndexedStack keeps every tab's widget mounted rather than tearing it down on switch, so
    // Home's content is still in the tree (just not the visible one) — this is what makes
    // switching back to a tab restore it exactly as it was left.
    expect(find.text('Home'), findsWidgets);

    await tester.tap(navLabel('Home'));
    await tester.pumpAndSettle();

    expect(stack().index, 0);
    expect(navBar().selectedIndex, 0);
  });
}
