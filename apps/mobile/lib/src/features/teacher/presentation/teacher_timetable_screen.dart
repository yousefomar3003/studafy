import 'package:flutter/material.dart';

import '../../timetable/application/weekly_schedule_providers.dart';
import '../../timetable/domain/weekly_schedule.dart';
import '../../timetable/presentation/weekly_schedule_view.dart';

/// The teacher's Timetable tab: every lesson they teach in the school's approved weekly
/// schedule, one teaching day at a time, each showing the class/section and room. Same view
/// and offline/freshness behaviour as the student's (`student/presentation/timetable_screen.dart`).
class TeacherTimetableScreen extends StatelessWidget {
  const TeacherTimetableScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return WeeklyScheduleTab(
      schedule: teacherWeeklyScheduleProvider,
      audience: ScheduleAudience.teacher,
    );
  }
}
