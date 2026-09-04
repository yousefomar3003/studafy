import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../application/viewer_providers.dart';
import 'viewer_section_card.dart';

/// School-wide count of teacher evaluations still in draft.
class EvaluationsOverviewCard extends ConsumerWidget {
  const EvaluationsOverviewCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(viewerDraftEvaluationsCountProvider);
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return ViewerSectionCard(
      titleKey: 'viewer.admin.evaluations.title',
      icon: Icons.assignment_outlined,
      child: count.when(
        loading: () => const ViewerCardSkeleton(lineCount: 1),
        error: (error, stackTrace) => const ViewerCardMessage(
          messageKey: 'viewer.admin.evaluations.error',
          icon: Icons.error_outline,
        ),
        data: (total) {
          if (total == 0) {
            return const ViewerCardMessage(
              messageKey: 'viewer.admin.evaluations.empty',
              icon: Icons.check_circle_outline,
            );
          }
          return Text(
            'viewer.admin.evaluations.count'.tr(namedArgs: {'count': '$total'}),
            style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
          );
        },
      ),
    );
  }
}
