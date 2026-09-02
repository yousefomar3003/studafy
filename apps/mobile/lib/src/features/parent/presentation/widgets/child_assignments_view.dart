import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/assignment_completion.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/child_detail_providers.dart';
import 'child_detail_placeholders.dart';

/// The Assignments tab of `ChildDetailScreen`: how much of the term's assigned work the child
/// has handed in, and how much of that was on time.
///
/// The child's own assignments screen lists each assignment with its submission; that list is
/// built from the student session's own per-assignment submission rows and has no parent-scoped
/// equivalent. The reporting API exposes the term-level completion counts instead — published
/// assignments in the classes the child is actively enrolled in for the term — which is what
/// this view shows.
class ChildAssignmentsView extends ConsumerWidget {
  const ChildAssignmentsView({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final breakdown = ref.watch(childBreakdownProvider(studentId));

    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(childBreakdownProvider(studentId)),
      child: breakdown.when(
        loading: () => const ChildDetailSkeleton(),
        error: (_, _) => const ChildDetailMessage(
          messageKey: 'parent.childDetail.error',
          icon: Icons.error_outline,
        ),
        data: (data) {
          final completion = data.assignments;
          if (completion.total == 0) {
            return const ChildDetailMessage(
              messageKey: 'parent.childDetail.assignments.empty',
              icon: Icons.info_outline,
            );
          }
          return ListView(
            padding: const EdgeInsets.all(AppSpacing.space16),
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              _CompletionCard(completion: completion),
              const SizedBox(height: AppSpacing.space12),
              Text(
                'parent.childDetail.assignments.note'.tr(),
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _CompletionCard extends StatelessWidget {
  const _CompletionCard({required this.completion});

  final AssignmentCompletion completion;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final fraction = (completion.completionPercent.toDouble() / 100).clamp(0.0, 1.0);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.assignment_turned_in_outlined, size: 20, color: colorScheme.primary),
                const SizedBox(width: AppSpacing.space8),
                Expanded(
                  child: Text(
                    'parent.childDetail.assignments.title'.tr(),
                    style: textTheme.titleMedium,
                  ),
                ),
                Text(
                  '${completion.completionPercent.round()}%',
                  style: textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space12),
            ClipRRect(
              borderRadius: BorderRadius.circular(999),
              child: LinearProgressIndicator(
                value: fraction,
                minHeight: 8,
                backgroundColor: colorScheme.surfaceContainerHighest,
              ),
            ),
            const SizedBox(height: AppSpacing.space16),
            _Row(
              label: 'parent.childDetail.assignments.submitted'.tr(),
              value: '${completion.submitted}/${completion.total}',
            ),
            _Row(
              label: 'parent.childDetail.assignments.onTime'.tr(),
              value: completion.onTime.toString(),
            ),
            _Row(
              label: 'parent.childDetail.assignments.late'.tr(),
              value: completion.lateValue.toString(),
            ),
          ],
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      child: Row(
        children: [
          Expanded(child: Text(label, style: textTheme.bodyMedium)),
          Text(value, style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}
