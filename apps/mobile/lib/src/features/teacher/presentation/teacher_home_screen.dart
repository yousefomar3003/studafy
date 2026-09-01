import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/teacher_providers.dart';
import 'widgets/teacher_grading_queue_card.dart';
import 'widgets/teacher_recent_submissions_card.dart';
import 'widgets/teacher_today_sessions_card.dart';

/// The teacher home tab: today's sessions with take-attendance CTAs, the pending-grading count,
/// and the most recent submissions.
///
/// Each card owns its provider and renders its own loading / empty / error state, so a slow
/// grading-queue fan-out never holds up today's sessions from showing. Pull-to-refresh
/// re-runs all three.
class TeacherHomeScreen extends ConsumerWidget {
  const TeacherHomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      onRefresh: () async {
        // Invalidating the two roots cascades to the derived providers the cards watch:
        // classes → published assignments → pending submissions.
        ref
          ..invalidate(teacherTodaySessionsProvider)
          ..invalidate(teacherClassesProvider);
      },
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.space16),
        children: const [
          TeacherTodaySessionsCard(),
          SizedBox(height: AppSpacing.space16),
          TeacherGradingQueueCard(),
          SizedBox(height: AppSpacing.space16),
          TeacherRecentSubmissionsCard(),
        ],
      ),
    );
  }
}
