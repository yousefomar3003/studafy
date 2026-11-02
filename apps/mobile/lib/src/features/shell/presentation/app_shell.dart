import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/features/features_providers.dart';
import '../../../core/push/push_providers.dart';
import '../application/shell_providers.dart';
import '../domain/shell_role.dart';
import 'deletion_pending_screen.dart';
import 'locale_toggle_button.dart';
import 'pill_navigation_bar.dart';
import 'push_permission_banner.dart';
import 'shell_destinations.dart';
import 'view_only_banner.dart';
import '../../../design/widgets/studafy_logo.dart';

/// The authenticated app's home: bottom navigation scoped to the session's resolved
/// [ShellRole], with a view-only banner and no mutation affordances for [ShellRole.viewer].
class AppShell extends ConsumerWidget {
  const AppShell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // A scheduled deletion confines the session to cancelling it or signing out (the API refuses
    // everything else), so the shell gives way to that choice until it is made.
    final deletionScheduledFor = ref
        .watch(accountProfileProvider)
        .value
        ?.deletionScheduledFor;
    if (deletionScheduledFor != null) {
      return DeletionPendingScreen(scheduledFor: deletionScheduledFor);
    }

    final shellRole = ref.watch(shellRoleProvider);

    // Keyed by role so switching accounts (a different session resolving to a different
    // shell) resets tab selection instead of carrying over an index from the old shell.
    return _AppShellScaffold(key: ValueKey(shellRole), shellRole: shellRole);
  }
}

class _AppShellScaffold extends ConsumerStatefulWidget {
  const _AppShellScaffold({super.key, required this.shellRole});

  final ShellRole shellRole;

  @override
  ConsumerState<_AppShellScaffold> createState() => _AppShellScaffoldState();
}

class _AppShellScaffoldState extends ConsumerState<_AppShellScaffold> {
  int _selectedIndex = 0;
  final _pageController = PageController();

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  /// A tap on the nav bar: slide to a neighbouring tab, jump straight to a farther one — sliding
  /// across would build every tab in between (and fire the requests they make).
  void _selectTab(int index) {
    if ((index - _selectedIndex).abs() == 1) {
      _pageController.animateToPage(
        index,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOutCubic,
      );
    } else {
      _pageController.jumpToPage(index);
    }
    _onTabChanged(index);
  }

  /// A swipe or a tap landed on [index].
  void _onTabChanged(int index) {
    if (index == _selectedIndex) return;
    setState(() => _selectedIndex = index);
    ref
        .read(selectedShellTabProvider.notifier)
        .select(shellDestinationsFor(widget.shellRole)[index].labelKey);
  }

  @override
  Widget build(BuildContext context) {
    final destinations = shellDestinationsFor(widget.shellRole);
    final pushSetup = ref.watch(pushSetupProvider);

    // A tab body can ask for another tab (the Home AI card opens the AI tab) by selecting it here.
    // The shell's own selections land on the tab already showing, so they are no-ops.
    ref.listen(selectedShellTabProvider, (previous, next) {
      final index = destinations.indexWhere((d) => d.labelKey == next);
      if (index >= 0 && index != _selectedIndex) _selectTab(index);
    });

    return Scaffold(
      // The floating nav bar has no backdrop of its own: tab content scrolls on behind it, and the
      // body sees the bar's height as its bottom `MediaQuery` padding (see `withBottomInset`).
      extendBody: true,
      appBar: AppBar(
        // Keyed by tab so the scrolled-under state (which tints the bar) resets on a tab switch
        // instead of carrying over from the previous tab's scroll position.
        key: ValueKey(_selectedIndex),
        // A subscribed student sees the subscriber mark in place of the wordmark.
        title:
            widget.shellRole == ShellRole.student &&
                ref.watch(hasPersonalSubscriptionProvider)
            ? const StudafyLogo.subscriber()
            : const StudafyLogo(),
        actions: const [LocaleToggleButton()],
      ),
      body: Column(
        children: [
          if (widget.shellRole == ShellRole.viewer) const ViewOnlyBanner(),
          if (pushSetup == PushSetup.needsPermission)
            const PushPermissionBanner(),
          Expanded(
            // Swipe left/right between tabs (mirrored in RTL, like the nav bar). PageView builds a
            // tab only once it scrolls into view, so a tab's body (and the providers it watches,
            // e.g. the AI tab's `GET /api/ai/usage`) stays unbuilt until first reached; after that
            // [_KeepAlive] keeps it mounted, so each tab's own state (scroll position, in-progress
            // input) survives switching away.
            child: PageView(
              controller: _pageController,
              onPageChanged: _onTabChanged,
              children: [
                for (final destination in destinations)
                  _KeepAlive(child: destination.body),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: PillNavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: _selectTab,
        destinations: [
          for (final destination in destinations)
            PillNavigationDestination(
              icon:
                  destination.decorateIcon?.call(Icon(destination.icon)) ??
                  Icon(destination.icon),
              label: destination.labelKey.tr(),
            ),
        ],
      ),
    );
  }
}

/// Keeps a swiped-away tab mounted inside the [PageView].
class _KeepAlive extends StatefulWidget {
  const _KeepAlive({required this.child});

  final Widget child;

  @override
  State<_KeepAlive> createState() => _KeepAliveState();
}

class _KeepAliveState extends State<_KeepAlive>
    with AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => true;

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return widget.child;
  }
}
