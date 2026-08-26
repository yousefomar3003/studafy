import 'package:flutter/material.dart';

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
        home,
        ShellDestination(
          labelKey: 'shell.tabs.courses',
          icon: Icons.menu_book_outlined,
          body: ShellTabPlaceholder(titleKey: 'shell.tabs.courses'),
        ),
        profile,
      ];
    case ShellRole.teacher:
      return const [
        home,
        ShellDestination(
          labelKey: 'shell.tabs.classes',
          icon: Icons.groups_outlined,
          body: ShellTabPlaceholder(titleKey: 'shell.tabs.classes'),
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
