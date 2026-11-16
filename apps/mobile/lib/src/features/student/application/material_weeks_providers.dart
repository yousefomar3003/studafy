import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/auth_providers.dart';
import '../../timetable/domain/weekly_schedule.dart';
import '../domain/material_weeks.dart';
import 'materials_providers.dart';

/// The clock the week sections use to find the current week. Override in tests.
final materialWeeksClockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// What [classId]'s materials are placed against: its term's dates (through the class's term) and
/// the school's teaching week (`GET /api/academics/timetable-settings`).
///
/// Never fails. Each half falls back on its own when it can't be read — no term dates (sections
/// keep their week numbers but lose their date ranges and current week), or all seven days Monday
/// first — so a student offline with cached materials still sees them grouped by week.
final materialWeekCalendarProvider = FutureProvider.autoDispose
    .family<MaterialWeekCalendar, String>((ref, classId) async {
      final api = ref.watch(apiClientProvider);

      Future<(DateTime, DateTime)?> termDates() async {
        try {
          final cls = await ref.watch(materialsClassProvider(classId).future);
          final term = await api.academics.getTerm(termId: cls.termId);
          return (term.startsOn, term.endsOn);
        } on Object {
          return null;
        }
      }

      Future<List<int>> teachingDays() async {
        try {
          final settings = await api.timetable.getTimetableSettings();
          return orderedSchoolDays(settings.schoolDays);
        } on Object {
          return allWeekdays;
        }
      }

      final (dates, days) = await (termDates(), teachingDays()).wait;
      return MaterialWeekCalendar(
        termStartsOn: dates?.$1,
        termEndsOn: dates?.$2,
        teachingDays: days,
      );
    });
