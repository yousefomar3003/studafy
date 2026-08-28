import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/today_providers.dart';
import 'widgets/today_announcements_card.dart';
import 'widgets/today_assignments_card.dart';
import 'widgets/today_grades_card.dart';
import 'widgets/today_timetable_card.dart';

/// The student home tab: today's timetable, due-soon assignments, newly published grades, and
/// the latest announcements, each loading and refreshing independently.
///
/// Each card owns its own provider (`application/today_providers.dart`) rather than this screen
/// gating on one combined "everything loaded" state — a slow timetable lookup should never hold
/// up an already-cached announcements feed from rendering.
class TodayScreen extends ConsumerWidget {
  const TodayScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      onRefresh: () async {
        ref
          ..invalidate(todayTimetableProvider)
          ..invalidate(todayAssignmentsProvider)
          ..invalidate(todayGradesProvider)
          ..invalidate(todayAnnouncementsProvider);
      },
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.space16),
        children: const [
          TodayTimetableCard(),
          SizedBox(height: AppSpacing.space16),
          TodayAssignmentsCard(),
          SizedBox(height: AppSpacing.space16),
          TodayGradesCard(),
          SizedBox(height: AppSpacing.space16),
          TodayAnnouncementsCard(),
        ],
      ),
    );
  }
}
