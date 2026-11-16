import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/student_context_providers.dart';
import '../grades_screen.dart';
import 'released_marks_widgets.dart';

/// The student home's "New exam marks" card: exam marks school leadership approved in the last
/// two weeks ([releasedMarksRecentWindow]), newest first, opening the Grades screen's "Exam
/// marks" tab. Takes no space at all when nothing new was released (or while it loads, or if it
/// fails), so the home only grows when there is news.
///
/// Reuses the marks endpoint and provider the Grades screen reads; no extra backend.
class TodayNewMarksCard extends ConsumerWidget {
  const TodayNewMarksCard({this.maxItems = 3, this.now, super.key});

  final int maxItems;

  /// The clock deciding what counts as new (tests); defaults to the current time.
  final DateTime? now;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final studentId = ref.watch(currentStudentIdProvider);
    if (studentId == null) return const SizedBox.shrink();

    return ReleasedMarksSummaryCard(
      studentId: studentId,
      titleKey: 'today.newMarks.title',
      maxItems: maxItems,
      recentOnly: true,
      now: now,
      // The gap before the next home card; it goes when this card does.
      margin: const EdgeInsets.only(bottom: AppSpacing.space16),
      onSeeAll: () => Navigator.of(
        context,
      ).push(MaterialPageRoute<void>(builder: (_) => const GradesScreen())),
    );
  }
}
