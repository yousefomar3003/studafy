import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/kit/kit.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/teacher_providers.dart';
import '../domain/teacher_class.dart';
import 'coordinator_subjects_screen.dart';
import 'grading_assignments_screen.dart';
import 'plan_reviews_screen.dart';
import 'teacher_class_detail_screen.dart';
import '../../../design/layout/bottom_inset_padding.dart';

/// The teacher "Classes" tab: every class the signed-in teacher leads this term, each opening
/// its roster. Scoped to the teacher's own classes — the list request filters by
/// `lead_teacher_id`, and the API enforces the same limit.
///
/// Led by the "Marks" entry ([GradingAssignmentsScreen]): academic marks are recorded per section
/// and subject rather than per class, so they get one entry point here instead of a per-class
/// action, shown whatever state the class list is in. A teacher who coordinates a subject also
/// gets the "Coordinator" entry ([CoordinatorEntryTile]) beneath it.
class TeacherClassListScreen extends ConsumerWidget {
  const TeacherClassListScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final classes = ref.watch(teacherClassSummariesProvider);

    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(teacherClassesProvider),
      child: classes.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stackTrace) => const _ScrollableMessage(
          icon: Icons.error_outline,
          messageKey: 'teacher.classes.error',
          header: _GradingEntries(),
        ),
        data: (list) {
          if (list.isEmpty) {
            return const _ScrollableMessage(
              icon: Icons.school_outlined,
              messageKey: 'teacher.classes.empty',
              header: _GradingEntries(),
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.all(
              AppSpacing.space16,
            ).withBottomInset(context),
            physics: const AlwaysScrollableScrollPhysics(),
            itemCount: list.length + 1,
            separatorBuilder: (context, index) =>
                const SizedBox(height: AppSpacing.space12),
            itemBuilder: (context, index) => index == 0
                ? const _GradingEntries()
                : _ClassTile(summary: list[index - 1]),
          );
        },
      ),
    );
  }
}

class _ClassTile extends StatelessWidget {
  const _ClassTile({required this.summary});

  final TeacherClass summary;

  @override
  Widget build(BuildContext context) {
    final visual = SubjectVisuals.of(
      summary.course.name,
      fallbackKey: summary.id,
    );

    return AppIconListCard(
      icon: visual.icon,
      accent: visual.accent,
      title: summary.code,
      subtitle: summary.course.name,
      trailing: AppStatusPill(
        icon: Icons.groups_outlined,
        label: 'teacher.classes.roster'.tr(
          namedArgs: {'count': '${summary.activeEnrollmentCount}'},
        ),
      ),
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => TeacherClassDetailScreen(
            classId: summary.id,
            classCode: summary.code,
          ),
        ),
      ),
    );
  }
}

/// The Marks entry, and the Coordinator and plan review entries for a teacher who coordinates a
/// subject.
class _GradingEntries extends StatelessWidget {
  const _GradingEntries();

  @override
  Widget build(BuildContext context) => const Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      MarksEntryTile(),
      CoordinatorEntryTile(),
      PlanReviewsEntryTile(),
    ],
  );
}

/// Opens the teacher's academic mark sheets ([GradingAssignmentsScreen]): a brand-tinted
/// call-to-action card leading the class list.
class MarksEntryTile extends StatelessWidget {
  const MarksEntryTile({super.key});

  @override
  Widget build(BuildContext context) {
    return AppIconListCard(
      // Filled, so the badge stands out from the card's own blue tint.
      leading: const AppIconBadge(
        icon: Icons.fact_check_outlined,
        accent: AppAccent.blue,
        filled: true,
      ),
      color: AppAccent.blue.colorsOf(context).container,
      title: 'teacher.marks.open'.tr(),
      subtitle: 'teacher.marks.openSubtitle'.tr(),
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => const GradingAssignmentsScreen(),
        ),
      ),
    );
  }
}

class _ScrollableMessage extends StatelessWidget {
  const _ScrollableMessage({
    required this.icon,
    required this.messageKey,
    this.header,
  });

  final IconData icon;
  final String messageKey;

  /// Shown above the message (the Marks entry, which doesn't depend on the class list).
  final Widget? header;

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(
        AppSpacing.space16,
      ).withBottomInset(context),
      children: [
        if (header != null) ...[
          header!,
          const SizedBox(height: AppSpacing.space24),
        ],
        AppEmptyState(
          icon: icon,
          message: messageKey.tr(),
          accent: icon == Icons.error_outline
              ? AppTone.danger.accent
              : AppAccent.blue,
        ),
      ],
    );
  }
}
