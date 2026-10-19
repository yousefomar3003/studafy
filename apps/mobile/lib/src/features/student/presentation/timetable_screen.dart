import 'package:flutter/material.dart';

import '../../timetable/application/weekly_schedule_providers.dart';
import '../../timetable/domain/weekly_schedule.dart';
import '../../timetable/presentation/weekly_schedule_view.dart';

/// The student's Timetable tab: the school's fixed weekly schedule narrowed to the classes they
/// are enrolled in, one teaching day at a time. Served from the offline cache first (see
/// [studentWeeklyScheduleProvider]) so a schedule already seen still shows with no connectivity,
/// marked stale. Exams live on their own screen, not here — this is the recurring week only.
class TimetableScreen extends StatelessWidget {
  const TimetableScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return WeeklyScheduleTab(
      schedule: studentWeeklyScheduleProvider,
      audience: ScheduleAudience.student,
    );
  }
}
