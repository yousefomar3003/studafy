import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../student/presentation/widgets/status_pill.dart';
import '../application/mark_sheet_providers.dart';
import '../domain/mark_sheet.dart';
import 'mark_sheet_screen.dart';
import 'widgets/mark_sheet_common.dart';

/// The teacher's "Marks" list: every section + subject they grade this academic year, each with
/// a summary of its periods' mark-sheet states (returned sheets first, since they need action).
///
/// Pushed from the Classes tab, so it owns its [Scaffold]. Opening a row pushes
/// [MarkSheetScreen]; coming back re-reads the list so a just-submitted period shows its new
/// state.
class GradingAssignmentsScreen extends ConsumerWidget {
  const GradingAssignmentsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final assignments = ref.watch(myGradingAssignmentsProvider);

    return Scaffold(
      appBar: AppBar(title: Text('teacher.marks.list.title'.tr())),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(myGradingAssignmentsProvider.future),
        child: assignments.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (_, _) => MarksMessage(
            icon: Icons.error_outline,
            message: 'teacher.marks.list.error'.tr(),
            onRetry: () => ref.invalidate(myGradingAssignmentsProvider),
          ),
          data: (list) {
            if (list.isEmpty) {
              return MarksMessage(
                icon: Icons.assignment_outlined,
                message: 'teacher.marks.list.empty'.tr(),
              );
            }
            return ListView.separated(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(
                AppSpacing.space16,
              ).withBottomInset(context),
              itemCount: list.length,
              separatorBuilder: (_, _) =>
                  const SizedBox(height: AppSpacing.space8),
              itemBuilder: (context, index) => _AssignmentTile(
                assignment: list[index],
                onOpen: () async {
                  final assignment = list[index];
                  await Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => MarkSheetScreen(
                        sectionId: assignment.sectionId,
                        subjectId: assignment.subjectId,
                        title: assignment.subjectName,
                      ),
                    ),
                  );
                  ref.invalidate(myGradingAssignmentsProvider);
                },
              ),
            );
          },
        ),
      ),
    );
  }
}

class _AssignmentTile extends StatelessWidget {
  const _AssignmentTile({required this.assignment, required this.onOpen});

  final GradingAssignment assignment;
  final VoidCallback onOpen;

  /// Returned first (needs the teacher), then draft, awaiting approval, approved.
  static const _order = [
    MarkSheetPeriodStatus.returned,
    MarkSheetPeriodStatus.draft,
    MarkSheetPeriodStatus.submitted,
    MarkSheetPeriodStatus.approved,
    MarkSheetPeriodStatus.unknown,
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final counts = assignment.statusCounts;

    return Card(
      margin: EdgeInsets.zero,
      child: InkWell(
        onTap: onOpen,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space16),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      assignment.subjectName,
                      style: theme.textTheme.titleMedium,
                    ),
                    const SizedBox(height: AppSpacing.space4),
                    Text(
                      'teacher.marks.list.sectionLine'.tr(
                        namedArgs: {
                          'grade': assignment.gradeLevelName,
                          'section': assignment.sectionName,
                        },
                      ),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    if (counts.isNotEmpty) ...[
                      const SizedBox(height: AppSpacing.space8),
                      Wrap(
                        spacing: AppSpacing.space8,
                        runSpacing: AppSpacing.space4,
                        children: [
                          for (final status in _order)
                            if (counts[status] case final count?)
                              StatusPill(
                                label: 'teacher.marks.list.statusCount'.tr(
                                  namedArgs: {
                                    'status':
                                        'teacher.marks.status.${status.name}'
                                            .tr(),
                                    'count': '$count',
                                  },
                                ),
                                tone: switch (status) {
                                  MarkSheetPeriodStatus.returned =>
                                    StatusPillTone.danger,
                                  MarkSheetPeriodStatus.submitted ||
                                  MarkSheetPeriodStatus.unknown =>
                                    StatusPillTone.warning,
                                  MarkSheetPeriodStatus.approved =>
                                    StatusPillTone.success,
                                  MarkSheetPeriodStatus.draft =>
                                    StatusPillTone.neutral,
                                },
                              ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
              const Icon(Icons.chevron_right),
            ],
          ),
        ),
      ),
    );
  }
}
