import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../application/viewer_providers.dart';
import 'viewer_section_card.dart';

/// School-wide attendance for the current term: present rate plus the raw record count.
class AttendanceOverviewCard extends ConsumerWidget {
  const AttendanceOverviewCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final overview = ref.watch(viewerAttendanceOverviewProvider);
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return ViewerSectionCard(
      titleKey: 'viewer.admin.attendance.title',
      icon: Icons.fact_check_outlined,
      child: overview.when(
        loading: () => const ViewerCardSkeleton(),
        error: (error, stackTrace) => const ViewerCardMessage(
          messageKey: 'viewer.admin.attendance.error',
          icon: Icons.error_outline,
        ),
        data: (totals) {
          if (totals.totalRecords == 0) {
            return const ViewerCardMessage(
              messageKey: 'viewer.admin.attendance.empty',
              icon: Icons.info_outline,
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('${totals.presentPercent.round()}%', style: textTheme.headlineSmall),
              Text(
                'viewer.admin.attendance.summary'.tr(
                  namedArgs: {
                    'present': '${totals.presentCount}',
                    'total': '${totals.totalRecords}',
                  },
                ),
                style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
              ),
            ],
          );
        },
      ),
    );
  }
}
