import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../../../design/widgets/today_date_hero.dart';
import '../application/teacher_providers.dart';
import 'widgets/take_attendance_button.dart';
import 'widgets/teacher_agenda_cards.dart';
import 'widgets/teacher_grading_queue_card.dart';
import 'widgets/teacher_recent_submissions_card.dart';
import 'widgets/teacher_today_sessions_card.dart';
import '../../../design/layout/bottom_inset_padding.dart';

/// The teacher home tab: today's date and time, a Take attendance action, today's sessions with
/// their attendance state, the pending-grading count, the most recent submissions, open work (and
/// unpublished drafts), and exams in the next two weeks.
///
/// Each card owns its provider and renders its own loading / empty / error state, so a slow
/// grading-queue fan-out never holds up today's sessions from showing. Pull-to-refresh
/// re-runs them all.
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
        padding: const EdgeInsets.all(
          AppSpacing.space16,
        ).withBottomInset(context),
        children: const [
          TodayDateHero(),
          SizedBox(height: AppSpacing.space16),
          TakeAttendanceButton(),
          SizedBox(height: AppSpacing.space16),
          TeacherTodaySessionsCard(),
          SizedBox(height: AppSpacing.space16),
          TeacherGradingQueueCard(),
          SizedBox(height: AppSpacing.space16),
          TeacherRecentSubmissionsCard(),
          SizedBox(height: AppSpacing.space16),
          TeacherOpenWorkCard(),
          SizedBox(height: AppSpacing.space16),
          TeacherUpcomingExamsCard(),
        ],
      ),
    );
  }
}
