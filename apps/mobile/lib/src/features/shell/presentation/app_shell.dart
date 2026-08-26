import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../application/shell_providers.dart';
import '../domain/shell_role.dart';
import 'locale_toggle_button.dart';
import 'shell_destinations.dart';
import 'view_only_banner.dart';

/// The authenticated app's home: bottom navigation scoped to the session's resolved
/// [ShellRole], with a view-only banner and no mutation affordances for [ShellRole.viewer].
class AppShell extends ConsumerWidget {
  const AppShell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final shellRole = ref.watch(shellRoleProvider);

    // Keyed by role so switching accounts (a different session resolving to a different
    // shell) resets tab selection instead of carrying over an index from the old shell.
    return _AppShellScaffold(key: ValueKey(shellRole), shellRole: shellRole);
  }
}

class _AppShellScaffold extends StatefulWidget {
  const _AppShellScaffold({super.key, required this.shellRole});

  final ShellRole shellRole;

  @override
  State<_AppShellScaffold> createState() => _AppShellScaffoldState();
}

class _AppShellScaffoldState extends State<_AppShellScaffold> {
  int _selectedIndex = 0;

  @override
  Widget build(BuildContext context) {
    final destinations = shellDestinationsFor(widget.shellRole);

    return Scaffold(
      appBar: AppBar(
        title: Text('app.title'.tr()),
        actions: const [LocaleToggleButton()],
      ),
      body: Column(
        children: [
          if (widget.shellRole == ShellRole.viewer) const ViewOnlyBanner(),
          Expanded(
            // IndexedStack keeps every tab mounted, so switching tabs preserves each tab's
            // own state (scroll position, in-progress input) instead of rebuilding it.
            child: IndexedStack(
              index: _selectedIndex,
              children: [for (final destination in destinations) destination.body],
            ),
          ),
        ],
      ),
      floatingActionButton: widget.shellRole.canMutate
          ? FloatingActionButton(
              onPressed: () {},
              child: const Icon(Icons.add),
            )
          : null,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: (index) => setState(() => _selectedIndex = index),
        destinations: [
          for (final destination in destinations)
            NavigationDestination(
              icon: Icon(destination.icon),
              label: destination.labelKey.tr(),
            ),
        ],
      ),
    );
  }
}
