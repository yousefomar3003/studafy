import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/assignment.dart';
import '../../../../core/offline/staleness_banner.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/today_providers.dart';
import '../assignment_detail_screen.dart';
import '../assignments_screen.dart';
import 'today_card_shell.dart';
import 'today_skeleton.dart';
import 'today_state_message.dart';

/// Due-soon assignments, nearest deadline first.
class TodayAssignmentsCard extends ConsumerWidget {
  const TodayAssignmentsCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final assignments = ref.watch(todayAssignmentsProvider);

    return TodayCardShell(
      titleKey: 'today.assignments.title',
      icon: Icons.assignment_outlined,
      child: assignments.when(
        loading: () => const TodaySkeleton(),
        error: (error, stackTrace) => const TodayStateMessage(
          messageKey: 'today.assignments.error',
          icon: Icons.error_outline,
        ),
        data: (cached) {
          if (cached.data.isEmpty) {
            return const TodayStateMessage(
              messageKey: 'today.assignments.empty',
              icon: Icons.check_circle_outline,
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (cached.isStale) ...[
                StalenessBanner(fetchedAt: cached.fetchedAt),
                const SizedBox(height: AppSpacing.space12),
              ],
              for (final assignment in cached.data) _AssignmentRow(assignment: assignment),
              Align(
                alignment: AlignmentDirectional.centerEnd,
                child: TextButton(
                  onPressed: () => Navigator.of(
                    context,
                  ).push(MaterialPageRoute<void>(builder: (_) => const StudentAssignmentsScreen())),
                  child: Text('today.assignments.viewAll'.tr()),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _AssignmentRow extends StatelessWidget {
  const _AssignmentRow({required this.assignment});

  final Assignment assignment;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final dueAt = DateFormat.MMMd(context.locale.toString()).add_jm().format(assignment.dueAt);

    return InkWell(
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => AssignmentDetailScreen(assignmentId: assignment.id),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
        child: Row(
          children: [
            Expanded(
              child: Text(
                assignment.title,
                style: textTheme.bodyMedium,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: AppSpacing.space8),
            Text(dueAt, style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant)),
          ],
        ),
      ),
    );
  }
}
