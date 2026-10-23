import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/assignment.dart';
import '../../../core/api/generated/models/assignment_status.dart';
import '../../../core/api/generated/models/exam.dart';
import '../../../core/api/generated/models/exam_status.dart';
import '../../../core/auth/auth_providers.dart';
import 'teacher_providers.dart';

/// How far ahead the teacher home looks for exams.
const upcomingExamsWindow = Duration(days: 14);

/// One exam on the teacher home, with the display code of the class sitting it.
typedef UpcomingExam = ({Exam exam, String classCode});

/// Published assignments that still take hand-ins (due in the future), soonest first.
final teacherOpenWorkProvider = FutureProvider<List<Assignment>>((ref) async {
  final now = DateTime.now();
  final published = await ref.watch(teacherPublishedAssignmentsProvider.future);
  return published.where((a) => a.dueAt.isAfter(now)).toList()
    ..sort((a, b) => a.dueAt.compareTo(b.dueAt));
});

/// Assignments the teacher has drafted but not yet published.
final teacherDraftAssignmentsProvider = FutureProvider<List<Assignment>>((
  ref,
) async {
  final assignments = await ref.watch(teacherAssignmentsProvider.future);
  return assignments.where((a) => a.status == AssignmentStatus.draft).toList();
});

/// Scheduled or open exams in the teacher's classes that haven't ended and start within
/// [upcomingExamsWindow], soonest first. One `GET /api/academics/exams` per class.
final teacherUpcomingExamsProvider = FutureProvider<List<UpcomingExam>>((
  ref,
) async {
  final classes = await ref.watch(teacherClassesProvider.future);
  final api = ref.watch(apiClientProvider);
  final now = DateTime.now();
  final horizon = now.add(upcomingExamsWindow);

  final pages = await Future.wait(
    classes.map((classInfo) async {
      final page = await api.academics.listExams(
        classId: classInfo.id,
        limit: 100,
      );
      return [
        for (final exam in page.exams)
          if ((exam.status == ExamStatus.scheduled ||
                  exam.status == ExamStatus.open) &&
              exam.endsAt.isAfter(now) &&
              exam.startsAt.isBefore(horizon))
            (exam: exam, classCode: classInfo.code),
      ];
    }),
  );
  return [for (final page in pages) ...page]
    ..sort((a, b) => a.exam.startsAt.compareTo(b.exam.startsAt));
});
