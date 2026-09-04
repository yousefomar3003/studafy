import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../application/viewer_providers.dart';
import 'viewer_section_card.dart';

/// School-wide count of discipline incidents still open (reported, under review, or escalated).
class DisciplineOverviewCard extends ConsumerWidget {
  const DisciplineOverviewCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(viewerOpenDisciplineCountProvider);
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return ViewerSectionCard(
      titleKey: 'viewer.admin.discipline.title',
      icon: Icons.gpp_maybe_outlined,
      child: count.when(
        loading: () => const ViewerCardSkeleton(lineCount: 1),
        error: (error, stackTrace) => const ViewerCardMessage(
          messageKey: 'viewer.admin.discipline.error',
          icon: Icons.error_outline,
        ),
        data: (total) {
          if (total == 0) {
            return const ViewerCardMessage(
              messageKey: 'viewer.admin.discipline.empty',
              icon: Icons.check_circle_outline,
            );
          }
          return Text(
            'viewer.admin.discipline.count'.tr(namedArgs: {'count': '$total'}),
            style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
          );
        },
      ),
    );
  }
}
