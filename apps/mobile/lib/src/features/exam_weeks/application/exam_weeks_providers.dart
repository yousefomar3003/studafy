import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/exam_weeks_client.dart';
import '../domain/exam_weeks.dart';

/// [ExamWeeksClient] on its own [authenticatedDio], like `graduationRequirementsClientProvider`.
final examWeeksClientProvider = Provider<ExamWeeksClient>((ref) {
  return ExamWeeksClient(authenticatedDio(ref));
});

/// A student's exam timetable — the signed-in student's own or a parent's child. Empty when the
/// school has published no exam period the student sits.
final studentExamTimetableProvider = FutureProvider.autoDispose
    .family<StudentExamTimetable, String>((ref, studentId) {
      return ref
          .watch(examWeeksClientProvider)
          .fetchStudentTimetable(studentId);
    });

/// The signed-in teacher's invigilation duties in published exam periods.
final myInvigilationDutiesProvider =
    FutureProvider.autoDispose<InvigilationDuties>((ref) {
      return ref.watch(examWeeksClientProvider).fetchMyDuties();
    });

/// Today's date, for splitting upcoming exams from past ones. Override in tests.
final examWeeksClockProvider = Provider<DateTime Function()>(
  (ref) => DateTime.now,
);
