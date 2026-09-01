import 'package:flutter/material.dart';

import '../../ai/presentation/ai_hub_screen.dart';
import '../../student/presentation/timetable_screen.dart';
import '../../student/presentation/today_screen.dart';
import '../../teacher/presentation/teacher_class_list_screen.dart';
import '../../teacher/presentation/teacher_home_screen.dart';
import '../domain/shell_role.dart';
import 'shell_tab_placeholder.dart';

/// One entry in a shell's bottom navigation: its translated label, icon, and tab body.
class ShellDestination {
  const ShellDestination({required this.labelKey, required this.icon, required this.body});

  /// Translation key for both the bottom navigation label and the tab's placeholder heading.
  final String labelKey;
  final IconData icon;
  final Widget body;
}

/// The bottom navigation destinations for [role]'s shell.
///
/// Every shell gets a Home and a Profile tab; roles with a mobile-relevant collection of
/// people/courses get one more tab for it. [ShellRole.viewer] gets the minimal two-tab set —
/// no domain-specific tab — matching its zero-mutation, view-only posture.
///
/// [ShellRole.student] alone also gets an AI tab. A parent can buy and manage the same per-student
/// add-on too (see `apps/web/src/app/routes.tsx`'s `account/ai` route comment), but that needs a
/// child-selection concept the parent shell's own "Children" tab doesn't have yet either — still a
/// [ShellTabPlaceholder] below — so a parent-facing AI tab is future scope for whichever ticket
/// builds that tab for real, not this one. `AiHubScreen` itself resolves
/// subscribed/unsubscribed/school-inactive from the signed-in student session.
List<ShellDestination> shellDestinationsFor(ShellRole role) {
  const home = ShellDestination(
    labelKey: 'shell.tabs.home',
    icon: Icons.home_outlined,
    body: ShellTabPlaceholder(titleKey: 'shell.tabs.home'),
  );
  const profile = ShellDestination(
    labelKey: 'shell.tabs.profile',
    icon: Icons.person_outline,
    body: ShellTabPlaceholder(titleKey: 'shell.tabs.profile'),
  );

  switch (role) {
    case ShellRole.student:
      return const [
        ShellDestination(
          labelKey: 'shell.tabs.home',
          icon: Icons.home_outlined,
          body: TodayScreen(),
        ),
        ShellDestination(
          labelKey: 'shell.tabs.timetable',
          icon: Icons.calendar_month_outlined,
          body: TimetableScreen(),
        ),
        ShellDestination(
          labelKey: 'shell.tabs.courses',
          icon: Icons.menu_book_outlined,
          body: ShellTabPlaceholder(titleKey: 'shell.tabs.courses'),
        ),
        ShellDestination(
          labelKey: 'shell.tabs.ai',
          icon: Icons.auto_awesome_outlined,
          body: AiHubScreen(),
        ),
        profile,
      ];
    case ShellRole.teacher:
      return const [
        ShellDestination(
          labelKey: 'shell.tabs.home',
          icon: Icons.home_outlined,
          body: TeacherHomeScreen(),
        ),
        ShellDestination(
          labelKey: 'shell.tabs.classes',
          icon: Icons.groups_outlined,
          body: TeacherClassListScreen(),
        ),
        profile,
      ];
    case ShellRole.parent:
      return const [
        home,
        ShellDestination(
          labelKey: 'shell.tabs.children',
          icon: Icons.family_restroom_outlined,
          body: ShellTabPlaceholder(titleKey: 'shell.tabs.children'),
        ),
        profile,
      ];
    case ShellRole.viewer:
      return const [home, profile];
  }
}
