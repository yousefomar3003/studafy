import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/push/push_providers.dart';
import 'package:studafy_mobile/src/features/ai/presentation/ai_hub_screen.dart';
import 'package:studafy_mobile/src/features/messaging/application/messaging_providers.dart';
import 'package:studafy_mobile/src/features/student/presentation/materials_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/today_screen.dart';
import 'package:studafy_mobile/src/features/shell/presentation/app_shell.dart';
import 'package:studafy_mobile/src/features/shell/presentation/pill_navigation_bar.dart';

import '../../support/fake_push_service.dart';
import '../../support/pump_app_shell.dart';
import '../../support/pump_studafy_app.dart';

List<String> navLabels(WidgetTester tester) => tester
    .widget<PillNavigationBar>(find.byType(PillNavigationBar))
    .destinations
    .map((destination) => destination.label)
    .toList();

void main() {
  group('lands each role in its own shell', () {
    testWidgets('student gets Home, Lessons, Work, AI, Profile', (
      tester,
    ) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: const ['STUDENT']),
      );

      expect(navLabels(tester), [
        'Home',
        'Lessons',
        'Work',
        'AI',
        'Profile',
      ]);

      // The Profile tab's account actions. The shell keeps every visited tab's *state* alive, but a
      // non-selected tab's content is still offstage — `find.text()` defaults to
      // `skipOffstage: true`, so this needs an actual tab switch first, same as the "tapping a
      // destination switches..." test below. Every role gets "Sign-in & security" (which holds "Delete
      // my account"); only the school admin
      // also gets "Delete school"; see ProfileTabScreen's doc comment and profile_delete_school_test.dart.
      await tester.tap(find.byTooltip('Profile'));
      await tester.pumpAndSettle();
      expect(find.text('Sign-in & security'), findsOneWidget);
      expect(find.text('Delete school'), findsNothing);
      expect(find.text('Privacy policy'), findsOneWidget);
    });

    testWidgets('instructor gets Home, Timetable, Classes, Messages, Profile', (
      tester,
    ) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: const ['INSTRUCTOR']),
      );

      expect(navLabels(tester), [
        'Home',
        'Timetable',
        'Classes',
        'Messages',
        'Profile',
      ]);
    });

    testWidgets('parent gets Home, Children, News, Messages, Profile', (
      tester,
    ) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: const ['PARENT']),
      );

      expect(navLabels(tester), [
        'Home',
        'Children',
        'News',
        'Messages',
        'Profile',
      ]);
    });

    testWidgets('the Messages tab icon carries the unread total', (
      tester,
    ) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: const ['PARENT']),
        overrides: [unreadMessagesTotalProvider.overrideWithValue(4)],
      );

      final messagesIcon = find.descendant(
        of: find.byType(PillNavigationBar),
        matching: find.byIcon(Icons.chat_bubble_outline),
      );
      expect(
        find.ancestor(of: messagesIcon, matching: find.byType(Badge)),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byType(PillNavigationBar),
          matching: find.text('4'),
        ),
        findsOneWidget,
      );
    });
  });

  group('admin-type and guest roles land in the read-only viewer shell', () {
    Future<void> expectViewerShell(
      WidgetTester tester,
      List<String> roles,
    ) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: roles),
      );

      expect(navLabels(tester), ['Home', 'Profile']);
      // No domain-specific tab.
      expect(find.text('Timetable'), findsNothing);
      expect(find.text('Lessons'), findsNothing);
      expect(find.text('Work'), findsNothing);
      expect(find.text('AI'), findsNothing);
      expect(find.text('Classes'), findsNothing);
      expect(find.text('Children'), findsNothing);
      expect(find.text('News'), findsNothing);
      expect(find.text('Messages'), findsNothing);
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

    testWidgets('an admin role alongside a teaching role still stays view-only', (
      tester,
    ) async {
      // Admin-type roles always win: mobile is never the admin console, even for a session
      // that also happens to teach.
      await expectViewerShell(tester, const ['ORG_ADMIN', 'INSTRUCTOR']);
    });
  });

  testWidgets(
    'tapping a destination switches the visible tab without losing the others',
    (tester) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: const ['STUDENT']),
      );

      // The shell's PageView is the outermost one (a tab may hold its own).
      int page() => tester
          .widget<PageView>(find.byType(PageView).first)
          .controller!
          .page!
          .round();
      PillNavigationBar navBar() =>
          tester.widget(find.byType(PillNavigationBar));
      // Unselected tabs render icon-only; their label lives in the tab's tooltip.
      Finder navLabel(String text) => find.byTooltip(text);

      expect(page(), 0);
      expect(navBar().selectedIndex, 0);

      await tester.tap(navLabel('Lessons'));
      await tester.pumpAndSettle();

      expect(page(), 1);
      expect(navBar().selectedIndex, 1);

      // Every visited tab is kept alive rather than torn down on switch, so
      // Home's content is still in the tree (just not the visible one) — this is what makes
      // switching back to a tab restore it exactly as it was left.
      expect(find.byType(TodayScreen, skipOffstage: false), findsOneWidget);

      await tester.tap(navLabel('Home'));
      await tester.pumpAndSettle();

      expect(page(), 0);
      expect(navBar().selectedIndex, 0);
    },
  );

  testWidgets('swiping moves to the neighbouring tab and the nav bar follows', (
    tester,
  ) async {
    await pumpAppShell(
      tester,
      session: await fakeAuthenticatedSession(roles: const ['STUDENT']),
    );

    PillNavigationBar navBar() => tester.widget(find.byType(PillNavigationBar));
    final pages = find.byType(PageView).first;

    await tester.fling(pages, const Offset(-400, 0), 1000);
    await tester.pumpAndSettle();
    expect(navBar().selectedIndex, 1);
    expect(find.byType(MaterialsScreen), findsOneWidget);

    await tester.fling(pages, const Offset(400, 0), 1000);
    await tester.pumpAndSettle();
    expect(navBar().selectedIndex, 0);
    expect(find.byType(TodayScreen), findsOneWidget);
  });

  group('sliding a finger along the nav bar selects the tab under it', () {
    PillNavigationBar navBar(WidgetTester tester) => tester.widget(find.byType(PillNavigationBar));

    testWidgets('straight away, like a swipe', (tester) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: const ['STUDENT']),
      );

      final gesture = await tester.startGesture(tester.getCenter(find.text('Home')));
      await gesture.moveTo(tester.getCenter(find.byTooltip('Lessons')));
      await tester.pump();
      expect(navBar(tester).selectedIndex, 1);

      await gesture.moveTo(tester.getCenter(find.byTooltip('Work')));
      await tester.pump();
      expect(navBar(tester).selectedIndex, 2);

      await gesture.up();
      await tester.pumpAndSettle();
      expect(navBar(tester).selectedIndex, 2);
      expect(tester.widget<PageView>(find.byType(PageView).first).controller?.page, 2);
    });

    testWidgets('after pressing and holding first', (tester) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: const ['STUDENT']),
      );

      final gesture = await tester.startGesture(tester.getCenter(find.text('Home')));
      await tester.pump(kLongPressTimeout + const Duration(milliseconds: 50));
      await gesture.moveTo(tester.getCenter(find.byTooltip('AI')));
      await tester.pump();
      expect(navBar(tester).selectedIndex, 3);

      await gesture.up();
      await tester.pumpAndSettle();
      expect(navBar(tester).selectedIndex, 3);
    });
  });

  testWidgets('builds a tab only once it is first selected, then keeps it mounted', (
    tester,
  ) async {
    await pumpAppShell(
      tester,
      session: await fakeAuthenticatedSession(roles: const ['STUDENT']),
    );

    Finder navLabel(String text) => find.byTooltip(text);
    final aiHub = find.byType(AiHubScreen, skipOffstage: false);
    final lessons = find.byType(MaterialsScreen, skipOffstage: false);

    // At startup only Home is built: the AI tab (whose provider calls GET /api/ai/usage) and
    // Lessons haven't been opened, so they must not exist anywhere in the tree yet.
    expect(find.byType(TodayScreen, skipOffstage: false), findsOneWidget);
    expect(aiHub, findsNothing);
    expect(lessons, findsNothing);

    await tester.tap(navLabel('AI'));
    await tester.pumpAndSettle();
    expect(aiHub, findsOneWidget);
    expect(lessons, findsNothing);

    // Switching away keeps the visited tab mounted (offstage) rather than disposing it.
    await tester.tap(navLabel('Home'));
    await tester.pumpAndSettle();
    expect(aiHub, findsOneWidget);
    expect(find.byType(TodayScreen, skipOffstage: false), findsOneWidget);
  });

  group('notification permission banner', () {
    Future<FakePushService> pumpAndInitPush(
      WidgetTester tester, {
      required bool permissionUnanswered,
    }) async {
      final push = FakePushService(permissionUnanswered: permissionUnanswered);
      addTearDown(push.dispose);
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: const ['STUDENT']),
        overrides: [pushServiceProvider.overrideWithValue(push)],
      );
      final container = ProviderScope.containerOf(
        tester.element(find.byType(AppShell)),
      );
      await container.read(pushSetupProvider.notifier).initialize();
      await tester.pumpAndSettle();
      return push;
    }

    const body =
        'Get a notification when a grade is posted, an assignment is due soon, or your school '
        'sends an announcement or attendance alert. Your phone will ask for permission next.';

    testWidgets(
      'explains notifications first, and only Continue shows the OS prompt',
      (tester) async {
        final push = await pumpAndInitPush(tester, permissionUnanswered: true);

        expect(find.text(body), findsOneWidget);
        expect(push.permissionRequests, 0);

        await tester.tap(find.text('Continue'));
        await tester.pumpAndSettle();

        expect(push.permissionRequests, 1);
        expect(find.text(body), findsNothing);
      },
    );

    testWidgets('is absent once the OS prompt has been answered', (
      tester,
    ) async {
      final push = await pumpAndInitPush(tester, permissionUnanswered: false);

      expect(find.text(body), findsNothing);
      expect(push.permissionRequests, 0);
    });
  });
}
