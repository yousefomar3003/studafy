import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../timetable/application/weekly_schedule_providers.dart';
import '../../timetable/domain/weekly_schedule.dart';
import '../../timetable/presentation/weekly_schedule_view.dart';

/// The teacher's Timetable tab: every lesson they teach in the school's approved weekly
/// schedule, one teaching day at a time, each showing the class and its grade section.
/// Teaching two or more sections adds a section filter ([teacherScheduleSectionFilterProvider]).
/// Same view and offline/freshness behaviour as the student's
/// (`student/presentation/timetable_screen.dart`).
class TeacherTimetableScreen extends ConsumerWidget {
  const TeacherTimetableScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return WeeklyScheduleTab(
      schedule: teacherWeeklyScheduleProvider,
      audience: ScheduleAudience.teacher,
      onSectionFilterChanged: (sectionId) => ref
          .read(teacherScheduleSectionFilterProvider.notifier)
          .select(sectionId),
    );
  }
}
