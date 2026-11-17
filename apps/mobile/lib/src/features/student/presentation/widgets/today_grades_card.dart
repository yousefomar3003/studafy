import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/published_grade_snapshot.dart';
import '../../../../core/offline/staleness_banner.dart';
import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/released_marks_providers.dart';
import '../../application/student_context_providers.dart';
import '../../application/today_providers.dart';
import '../../domain/recent_grades.dart';
import '../../domain/released_marks.dart';
import '../../domain/today_section.dart';
import '../grades_screen.dart';
import 'recent_grades_widgets.dart';
import 'today_card_shell.dart';
import 'today_skeleton.dart';
import 'today_state_message.dart';

/// The home's "Recent grades": the newest exam marks school leadership approved and the newest
/// published assignment grades for the current term, together and newest first, each labelled
/// with its kind ([GradeKindChip]) so the two never read alike. An exam mark opens the Grades
/// screen's "Exams" tab, an assignment grade its "Assignments" tab.
///
/// Assignment grades come from [todayGradesProvider] (offline-aware, and live — see its doc
/// comment); exam marks from [studentReleasedMarksProvider], the endpoint the "Exams" tab reads.
/// Either source failing still shows the other's items; the card waits for both on first load so
/// the list doesn't reshuffle as the second one lands.
class TodayGradesCard extends ConsumerWidget {
  const TodayGradesCard({this.maxItems = 4, super.key});

  final int maxItems;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final section = ref.watch(todayGradesProvider);
    final studentId = ref.watch(currentStudentIdProvider);
    final marks = studentId == null ? null : ref.watch(studentReleasedMarksProvider(studentId));

    return TodayCardShell(
      titleKey: 'grades.recent.title',
      icon: Icons.grade_outlined,
      accent: AppAccent.emerald,
      child: _body(section, marks),
    );
  }

  Widget _body(
    AsyncValue<TodaySection<PublishedGradeSnapshot>> section,
    AsyncValue<List<ReleasedMarkPeriod>>? marks,
  ) {
    if ((section.isLoading && !section.hasValue && !section.hasError) ||
        (marks != null && marks.isLoading && !marks.hasValue && !marks.hasError)) {
      return const TodaySkeleton();
    }

    final ready = switch (section.value) {
      TodaySectionReady(:final value) => value,
      _ => null,
    };
    final items = mergeRecentGrades(
      grades: ready?.data.grades ?? const [],
      marks: marks?.value ?? const [],
    );

    if (items.isEmpty) {
      if (section.hasError) {
        return const TodayStateMessage(messageKey: 'today.grades.error', icon: Icons.error_outline);
      }
      if (section.value is TodaySectionUnavailable) {
        return const TodayStateMessage(
          messageKey: 'today.grades.unavailable',
          icon: Icons.info_outline,
        );
      }
      return const TodayStateMessage(
        messageKey: 'grades.recent.empty',
        icon: Icons.check_circle_outline,
      );
    }

    return _RecentGrades(
      items: items,
      maxItems: maxItems,
      staleSince: ready != null && ready.isStale ? ready.fetchedAt : null,
    );
  }
}

class _RecentGrades extends StatelessWidget {
  const _RecentGrades({required this.items, required this.maxItems, required this.staleSince});

  final List<RecentGrade> items;
  final int maxItems;

  /// When the cached assignment grades were fetched, if they are stale.
  final DateTime? staleSince;

  @override
  Widget build(BuildContext context) {
    void open(GradeKind kind) => Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => GradesScreen(
          initialTab: kind == GradeKind.exam ? GradesTab.exams : GradesTab.assignments,
        ),
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (staleSince case final fetchedAt?) ...[
          StalenessBanner(fetchedAt: fetchedAt),
          const SizedBox(height: AppSpacing.space12),
        ],
        RecentGradesList(
          items: items,
          maxItems: maxItems,
          onTap: (item) =>
              () => open(item.kind),
        ),
        Align(
          alignment: AlignmentDirectional.centerEnd,
          child: TextButton(
            // Onto the tab of the newest item, where it is listed in full.
            onPressed: () => open(items.first.kind),
            child: Text('grades.viewAll'.tr()),
          ),
        ),
      ],
    );
  }
}
