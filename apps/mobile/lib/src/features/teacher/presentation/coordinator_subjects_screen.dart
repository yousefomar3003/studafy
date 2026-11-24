import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/kit/kit.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/coordinator_providers.dart';
import '../domain/coordinator.dart';
import '../domain/mark_sheet.dart';
import 'coordinator_mark_sheet_screen.dart';
import 'widgets/mark_sheet_common.dart';

/// Opens [CoordinatorSubjectsScreen] from the Classes tab, under the Marks entry. Shown only to a
/// teacher who coordinates a subject this year (000260): while the overview loads, fails or is
/// empty, it takes no space.
class CoordinatorEntryTile extends ConsumerWidget {
  const CoordinatorEntryTile({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final subjects = ref.watch(myCoordinatedSubjectsProvider).value;
    if (subjects == null || subjects.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.space12),
      child: AppIconListCard(
        leading: const AppIconBadge(
          icon: Icons.hub_outlined,
          accent: AppAccent.violet,
          filled: true,
        ),
        color: AppAccent.violet.colorsOf(context).container,
        title: 'teacher.coordinator.open'.tr(),
        subtitle: 'teacher.coordinator.openSubtitle'.tr(
          namedArgs: {
            'subjects': subjects.subjects.map((s) => s.subjectName).join(', '),
          },
        ),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => const CoordinatorSubjectsScreen(),
          ),
        ),
      ),
    );
  }
}

/// The subjects the signed-in teacher coordinates, each across every section it covers: who
/// teaches it there, how many students take it, each period's mark-sheet status, the current
/// average from the marks recorded so far, and the averages of finalized results. Opening a
/// section pushes its marks, read-only ([CoordinatorMarkSheetScreen]).
class CoordinatorSubjectsScreen extends ConsumerWidget {
  const CoordinatorSubjectsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final overview = ref.watch(myCoordinatedSubjectsProvider);

    return Scaffold(
      appBar: AppBar(title: Text('teacher.coordinator.title'.tr())),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(myCoordinatedSubjectsProvider.future),
        child: overview.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (_, _) => MarksMessage(
            icon: Icons.error_outline,
            message: 'teacher.coordinator.error'.tr(),
            onRetry: () => ref.invalidate(myCoordinatedSubjectsProvider),
          ),
          data: (data) {
            if (data.isEmpty) {
              return MarksMessage(
                icon: Icons.hub_outlined,
                message: 'teacher.coordinator.empty'.tr(),
              );
            }
            return ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(
                AppSpacing.space16,
              ).withBottomInset(context),
              children: [
                Text(
                  'teacher.coordinator.readOnlyNote'.tr(),
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
                for (final subject in data.subjects) ...[
                  const SizedBox(height: AppSpacing.space16),
                  _SubjectHeader(subject: subject),
                  const SizedBox(height: AppSpacing.space8),
                  if (subject.sections.isEmpty)
                    Text('teacher.coordinator.noSections'.tr())
                  else
                    for (final section in subject.sections)
                      _SectionCard(
                        subject: subject,
                        section: section,
                        onOpen: () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => CoordinatorMarkSheetScreen(
                              sectionId: section.sectionId,
                              subjectId: subject.subjectId,
                              title: subject.subjectName,
                            ),
                          ),
                        ),
                      ),
                ],
              ],
            );
          },
        ),
      ),
    );
  }
}

class _SubjectHeader extends StatelessWidget {
  const _SubjectHeader({required this.subject});

  final CoordinatedSubject subject;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final grades = {
      for (final section in subject.sections) section.gradeLevelName,
    }.where((name) => name.isNotEmpty).join(', ');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(subject.subjectName, style: theme.textTheme.titleLarge),
        Text(
          subject.gradeLevelIds.isEmpty
              ? 'teacher.coordinator.allGrades'.tr()
              : 'teacher.coordinator.grades'.tr(namedArgs: {'grades': grades}),
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

class _SectionCard extends StatelessWidget {
  const _SectionCard({
    required this.subject,
    required this.section,
    required this.onOpen,
  });

  final CoordinatedSubject subject;
  final CoordinatedSection section;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final average = section.averagePercentage;

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space8),
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
                      'teacher.marks.list.sectionLine'.tr(
                        namedArgs: {
                          'grade': section.gradeLevelName,
                          'section': section.sectionName,
                        },
                      ),
                      style: theme.textTheme.titleMedium,
                    ),
                    const SizedBox(height: AppSpacing.space4),
                    Text(
                      section.teacherNames.isEmpty
                          ? 'teacher.coordinator.noTeacher'.tr()
                          : section.teacherNames.join(', '),
                      style: muted,
                    ),
                    Text(
                      'teacher.coordinator.students'.tr(
                        namedArgs: {
                          'count': '${section.studentCount}',
                          'complete': '${section.completeCount}',
                        },
                      ),
                      style: muted,
                    ),
                    const SizedBox(height: AppSpacing.space8),
                    Text(
                      average == null
                          ? 'teacher.coordinator.noAverage'.tr()
                          : 'teacher.coordinator.average'.tr(
                              namedArgs: {
                                'percentage': formatMarkNumber(average),
                              },
                            ),
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    for (final result in section.results)
                      Text(
                        'teacher.coordinator.finalAverage'.tr(
                          namedArgs: {
                            'period':
                                result.termName ??
                                'teacher.marks.period.annual'.tr(),
                            'percentage': result.averagePercentage == null
                                ? '—'
                                : formatMarkNumber(result.averagePercentage!),
                          },
                        ),
                        style: muted,
                      ),
                    if (section.sheets.isNotEmpty) ...[
                      const SizedBox(height: AppSpacing.space8),
                      Wrap(
                        spacing: AppSpacing.space8,
                        runSpacing: AppSpacing.space4,
                        children: [
                          for (final sheet in section.sheets)
                            _SheetChip(
                              period:
                                  sheet.termName ??
                                  'teacher.marks.period.annual'.tr(),
                              status: sheet.status,
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

/// One period's name beside its mark-sheet status.
class _SheetChip extends StatelessWidget {
  const _SheetChip({required this.period, required this.status});

  final String period;
  final MarkSheetPeriodStatus status;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(period, style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(width: AppSpacing.space4),
        MarkPeriodStatusPill(status: status),
      ],
    );
  }
}
