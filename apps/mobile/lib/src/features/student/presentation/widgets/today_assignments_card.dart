import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/assignment.dart';
import '../../../../core/offline/staleness_banner.dart';
import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/today_providers.dart';
import '../assignment_detail_screen.dart';
import '../work_and_grades_screen.dart';
import 'today_card_shell.dart';
import 'today_skeleton.dart';
import 'today_state_message.dart';

/// Due-soon assignments, nearest deadline first.
///
/// Capped at [maxItems] — the same bound [TodayAnnouncementsCard] applies — so an exam-season
/// backlog can't turn the today tab's assignments card into an unbounded column inside the
/// non-virtualized today `ListView`.
class TodayAssignmentsCard extends ConsumerWidget {
  const TodayAssignmentsCard({this.maxItems = 5, super.key});

  final int maxItems;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final assignments = ref.watch(todayAssignmentsProvider);

    return TodayCardShell(
      titleKey: 'today.assignments.title',
      icon: Icons.assignment_outlined,
      accent: AppAccent.amber,
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
          final items = cached.data.take(maxItems);
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (cached.isStale) ...[
                StalenessBanner(fetchedAt: cached.fetchedAt),
                const SizedBox(height: AppSpacing.space12),
              ],
              for (final assignment in items) _AssignmentRow(assignment: assignment),
              Align(
                alignment: AlignmentDirectional.centerEnd,
                child: TextButton(
                  // The "Work & grades" tab's assignments, the full list.
                  onPressed: () => openStudentAssignments(context, ref),
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
    final dueAt = DateFormat.MMMd(context.locale.toString()).add_jm().format(assignment.dueAt);

    return AppIconListTile(
      icon: Icons.assignment_outlined,
      accent: AppAccent.amber,
      title: assignment.title,
      subtitle: dueAt,
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => AssignmentDetailScreen(assignmentId: assignment.id),
        ),
      ),
    );
  }
}
