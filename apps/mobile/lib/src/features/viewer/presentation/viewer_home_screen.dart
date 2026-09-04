import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../shell/presentation/shell_tab_placeholder.dart';
import '../application/viewer_providers.dart';
import '../domain/viewer_role.dart';
import 'admin_overview_screen.dart';
import 'finance_overview_screen.dart';

/// The viewer shell's home tab: which read-only summary it shows depends on the session's own
/// role, not just that it landed on [ShellRole.viewer] — see [resolveViewerRole].
class ViewerHomeScreen extends ConsumerWidget {
  const ViewerHomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return switch (ref.watch(viewerRoleProvider)) {
      ViewerRole.admin => const AdminOverviewScreen(),
      ViewerRole.finance => const FinanceOverviewScreen(),
      // SUPPORT_AGENT and any unrecognized claim: no mobile-relevant summary yet, same honest
      // placeholder every other unshipped shell tab uses.
      ViewerRole.unsupported => const ShellTabPlaceholder(titleKey: 'shell.tabs.home'),
    };
  }
}
