import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/parent_providers.dart';
import 'widgets/child_summary.dart';
import 'widgets/child_switcher.dart';
import 'widgets/parent_notifications_card.dart';

/// The parent home tab: a switcher across the parent's linked children, the selected child's
/// per-term summary (attendance, latest grades, fees due), and the combined notifications feed.
///
/// Each card owns its provider and its own loading / empty / error state, so a slow finance
/// lookup never holds up attendance from rendering. Pull-to-refresh re-runs them all.
class ParentHomeScreen extends ConsumerWidget {
  const ParentHomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      onRefresh: () async {
        ref
          ..invalidate(childComparisonProvider)
          ..invalidate(parentFamilyIdProvider)
          ..invalidate(familyFinanceProvider)
          ..invalidate(parentNotificationsProvider);
      },
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.space16),
        children: const [
          ChildSwitcher(),
          SizedBox(height: AppSpacing.space16),
          ChildSummary(),
          SizedBox(height: AppSpacing.space16),
          ParentNotificationsCard(),
        ],
      ),
    );
  }
}
