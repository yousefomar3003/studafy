import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../timetable/domain/weekly_schedule.dart';
import '../../../timetable/presentation/weekly_schedule_view.dart';
import '../../application/child_detail_providers.dart';
import '../../domain/child_timetable.dart';
import 'child_detail_placeholders.dart';

/// The Timetable tab of `ChildDetailScreen`: the child's approved weekly schedule, rendered by
/// the same [WeeklyScheduleView] as the student's own Timetable tab. The parent endpoint resolves
/// every display name server-side, so the lesson cards get them as [LessonLabels] rather than
/// looking them up through academics endpoints a parent session cannot read.
class ChildTimetableView extends ConsumerWidget {
  const ChildTimetableView({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    Future<void> onRefresh() async {
      ref.invalidate(childTimetableProvider(studentId));
      try {
        await ref.read(childTimetableProvider(studentId).future);
      } on Object {
        // Surfaced by the tab itself; the refresh gesture only needs to finish.
      }
    }

    return ref
        .watch(childTimetableProvider(studentId))
        .when(
          loading: () => const ChildDetailSkeleton(),
          error: (_, _) => RefreshIndicator(
            onRefresh: onRefresh,
            child: const ChildDetailMessage(
              messageKey: 'parent.childDetail.timetable.error',
              icon: Icons.error_outline,
            ),
          ),
          data: (timetable) {
            if (!timetable.isPublished) {
              return RefreshIndicator(
                onRefresh: onRefresh,
                child: const ChildDetailMessage(
                  messageKey: 'parent.childDetail.timetable.unpublished',
                  hintKey: 'parent.childDetail.timetable.unpublishedHint',
                  icon: Icons.info_outline,
                ),
              );
            }
            if (timetable.slots.isEmpty) {
              return RefreshIndicator(
                onRefresh: onRefresh,
                child: const ChildDetailMessage(
                  messageKey: 'parent.childDetail.timetable.empty',
                  hintKey: 'parent.childDetail.timetable.emptyHint',
                  icon: Icons.event_available_outlined,
                ),
              );
            }
            final adapted = childWeeklySchedule(timetable);
            return WeeklyScheduleView(
              schedule: adapted.schedule,
              audience: ScheduleAudience.student,
              lessonLabels: adapted.labels,
              onRefresh: onRefresh,
            );
          },
        );
  }
}
