import 'package:flutter/material.dart';

import '../../ai/presentation/ai_hub_screen.dart';
import '../../attendance_office/presentation/registers_screen.dart';
import '../../messaging/presentation/parent_messages_screen.dart';
import '../../messaging/presentation/teacher_messages_screen.dart';
import '../../messaging/presentation/widgets/unread_messages_badge.dart';
import '../../notifications/presentation/notifications_screen.dart';
import '../../parent/presentation/child_detail_screen.dart';
import '../../parent/presentation/parent_communication_screen.dart';
import '../../parent/presentation/parent_home_screen.dart';
import '../../student/presentation/assignments_screen.dart';
import '../../student/presentation/materials_screen.dart';
import '../../student/presentation/today_screen.dart';
import '../../teacher/presentation/teacher_class_list_screen.dart';
import '../../teacher/presentation/teacher_home_screen.dart';
import '../../teacher/presentation/teacher_timetable_screen.dart';
import '../../viewer/presentation/viewer_home_screen.dart';
import '../domain/shell_role.dart';
import 'profile_tab_screen.dart';

/// One entry in a shell's bottom navigation: its translated label, icon, and tab body.
class ShellDestination {
  const ShellDestination({
    required this.labelKey,
    required this.icon,
    required this.body,
    this.selectedIcon,
    this.decorateIcon,
  });

  /// Translation key for both the bottom navigation label and the tab's placeholder heading.
  final String labelKey;
  final IconData icon;

  /// The filled variant shown while this tab is selected; [icon] when null.
  final IconData? selectedIcon;
  final Widget body;

  /// Wraps the navigation icon, e.g. with an unread badge. A top-level function tear-off, so
  /// destinations stay `const`.
  final Widget Function(Widget icon)? decorateIcon;
}

/// The bottom navigation destinations for [role]'s shell.
///
/// Every shell gets a Home and a Profile tab; roles with a mobile-relevant collection of
/// people/courses get one more tab for it, and the teacher gets a Timetable tab. The two sides of parent ↔ teacher messaging
/// (parent, teacher) get a Messages tab, badged with the unread total. [ShellRole.viewer] gets the minimal
/// two-tab set — no domain-specific tab — matching its zero-mutation, view-only posture; its
/// Home tab still varies by the session's actual role, via [ViewerHomeScreen].
///
/// [ShellRole.student] swaps the Timetable tab for Lessons (the materials library) and Work
/// (assignments); its weekly timetable stays one tap away from the Today timetable card.
///
/// [ShellRole.parent] also gets a News tab: the school's announcements and attendance alerts
/// ([ParentCommunicationScreen]), which the home's notifications card opens too.
///
/// [ShellRole.student] alone also gets an AI tab. A parent can buy and manage the same per-student
/// add-on too (see `apps/web/src/app/routes.tsx`'s `account/ai` route comment); the parent home
/// now carries the per-child selection such a tab would scope through, but `AiHubScreen` still
/// resolves subscribed/unsubscribed/school-inactive from a *student* session, so a parent-facing
/// AI tab remains future scope for whichever ticket builds it against a parent session.
///
/// [ShellRole.attendanceOfficer] gets Registers (its home: every class's daily register),
/// Notifications and Profile. No other shell has a notifications inbox yet, so that tab is a
/// placeholder until one is built.
List<ShellDestination> shellDestinationsFor(ShellRole role) {
  const profile = ShellDestination(
    labelKey: 'shell.tabs.profile',
    icon: Icons.person_outline,
    selectedIcon: Icons.person,
    body: ProfileTabScreen(),
  );

  switch (role) {
    case ShellRole.student:
      return const [
        ShellDestination(
          labelKey: 'shell.tabs.home',
          icon: Icons.home_outlined,
          selectedIcon: Icons.home_rounded,
          body: TodayScreen(),
        ),
        ShellDestination(
          labelKey: 'shell.tabs.lessons',
          icon: Icons.menu_book_outlined,
          selectedIcon: Icons.menu_book,
          body: MaterialsScreen(),
        ),
        ShellDestination(
          labelKey: 'shell.tabs.work',
          icon: Icons.assignment_outlined,
          selectedIcon: Icons.assignment,
          body: StudentAssignmentsScreen(),
        ),
        ShellDestination(
          labelKey: 'shell.tabs.ai',
          icon: Icons.auto_awesome_outlined,
          selectedIcon: Icons.auto_awesome,
          body: AiHubScreen(),
        ),
        profile,
      ];
    case ShellRole.teacher:
      return const [
        ShellDestination(
          labelKey: 'shell.tabs.home',
          icon: Icons.home_outlined,
          selectedIcon: Icons.home_rounded,
          body: TeacherHomeScreen(),
        ),
        ShellDestination(
          labelKey: 'shell.tabs.timetable',
          icon: Icons.view_week_outlined,
          selectedIcon: Icons.view_week,
          body: TeacherTimetableScreen(),
        ),
        ShellDestination(
          labelKey: 'shell.tabs.classes',
          icon: Icons.groups_outlined,
          selectedIcon: Icons.groups,
          body: TeacherClassListScreen(),
        ),
        ShellDestination(
          labelKey: 'shell.tabs.messages',
          icon: Icons.chat_bubble_outline,
          selectedIcon: Icons.chat_bubble,
          body: TeacherMessagesScreen(),
          decorateIcon: unreadMessagesBadge,
        ),
        profile,
      ];
    case ShellRole.parent:
      return const [
        ShellDestination(
          labelKey: 'shell.tabs.home',
          icon: Icons.home_outlined,
          selectedIcon: Icons.home_rounded,
          body: ParentHomeScreen(),
        ),
        ShellDestination(
          labelKey: 'shell.tabs.children',
          icon: Icons.family_restroom_outlined,
          selectedIcon: Icons.family_restroom,
          body: ChildDetailScreen(),
        ),
        ShellDestination(
          labelKey: 'shell.tabs.news',
          icon: Icons.campaign_outlined,
          selectedIcon: Icons.campaign,
          body: ParentCommunicationScreen(),
        ),
        ShellDestination(
          labelKey: 'shell.tabs.messages',
          icon: Icons.chat_bubble_outline,
          selectedIcon: Icons.chat_bubble,
          body: ParentMessagesScreen(),
          decorateIcon: unreadMessagesBadge,
        ),
        profile,
      ];
    case ShellRole.attendanceOfficer:
      return const [
        ShellDestination(
          labelKey: 'shell.tabs.registers',
          icon: Icons.fact_check_outlined,
          selectedIcon: Icons.fact_check,
          body: RegistersScreen(),
        ),
        ShellDestination(
          labelKey: 'shell.tabs.notifications',
          icon: Icons.notifications_none_outlined,
          selectedIcon: Icons.notifications,
          body: NotificationsInboxView(),
        ),
        profile,
      ];
    case ShellRole.viewer:
      return const [
        ShellDestination(
          labelKey: 'shell.tabs.home',
          icon: Icons.home_outlined,
          selectedIcon: Icons.home_rounded,
          body: ViewerHomeScreen(),
        ),
        profile,
      ];
  }
}
