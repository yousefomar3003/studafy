import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/assignment.dart';
import '../../../core/api/generated/models/assignment_status.dart';
import '../../../core/api/generated/models/class.dart';
import '../../../core/api/generated/models/enrollment.dart';
import '../../../core/api/generated/models/grade_status.dart';
import '../../../core/api/generated/models/status10.dart';
import '../../../core/api/generated/models/status11.dart';
import '../../../core/api/generated/models/status9.dart';
import '../../../core/api/generated/models/submission_status.dart';
import '../../../core/auth/auth_providers.dart';
// `currentTermProvider` resolves the school's active year + term — school-scoped context, not
// student-specific. It currently lives in the student feature (its first consumer); this second
// consumer is the cue to promote it to a shared location (e.g. `core/academics/`). Kept as a
// direct import rather than duplicating the two list calls.
import '../../student/application/current_term_provider.dart';
import '../domain/teacher_class.dart';
import '../domain/teacher_home.dart';

// ---------------------------------------------------------------------------
// Identity — the seam every other request scopes through
// ---------------------------------------------------------------------------

/// The signed-in teacher's id, from `GET /api/teachers/me`.
///
/// `/api/teachers/me` is the one teacher-directory call this app can make: it is reachable on
/// the mobile channel and needs no `TEACHER_READ`, whereas `/api/teachers` and
/// `/api/teachers/{id}` are web-channel-only. Everything below scopes to this id so a teacher
/// only ever sees the classes they lead — the same limit the API enforces server-side.
final teacherIdProvider = FutureProvider<String>((ref) async {
  final profile = await ref.watch(apiClientProvider).teachers.getTeacherMe();
  return profile.id;
});

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

/// The active classes the signed-in teacher leads in the current term — the raw list, without
/// the per-class course/roster lookups [teacherClassSummariesProvider] adds. The home screen's
/// grading pipeline needs only these ids, so it does not pay for that enrichment.
final teacherClassesProvider = FutureProvider<List<Class>>((ref) async {
  final teacherId = await ref.watch(teacherIdProvider.future);
  final term = await ref.watch(currentTermProvider.future);

  final list = await ref.watch(apiClientProvider).academics.listClasses(
        leadTeacherId: teacherId,
        termId: term.id,
        status: Status9.active,
        limit: 100,
      );
  return list.classes;
});

/// The teacher's classes enriched with course and current roster size, for the classes list.
///
/// One course lookup and one roster count per class. That is an N-call fan-out, but bounded by
/// a single teacher's own class count (single digits in practice); a list response that
/// embedded the course name and enrolment total would remove it.
final teacherClassSummariesProvider = FutureProvider<List<TeacherClass>>((ref) async {
  final classes = await ref.watch(teacherClassesProvider.future);
  final api = ref.watch(apiClientProvider);

  return Future.wait(
    classes.map((classInfo) async {
      final course = await api.academics.getCourse(courseId: classInfo.courseId);
      final roster = await api.academics.listEnrollments(
        classId: classInfo.id,
        status: Status10.active,
        limit: 1,
      );
      return TeacherClass(
        classInfo: classInfo,
        course: course,
        activeEnrollmentCount: roster.total,
      );
    }).toList(),
  );
});

/// The course name for one class, for the class-detail header. A small pair of lookups that
/// Riverpod's own `.family` cache is enough to hold — not a screen data source in its own right.
final classCourseNameProvider = FutureProvider.family<String, String>((ref, classId) async {
  final api = ref.watch(apiClientProvider);
  final classInfo = await api.academics.getClass(classId: classId);
  final course = await api.academics.getCourse(courseId: classInfo.courseId);
  return course.name;
});

/// The active roster for one class, oldest enrolment first.
final classRosterProvider = FutureProvider.family<List<Enrollment>, String>((ref, classId) async {
  final list = await ref.watch(apiClientProvider).academics.listEnrollments(
        classId: classId,
        status: Status10.active,
        limit: 200,
      );
  return list.enrollments.toList()..sort((a, b) => a.enrolledAt.compareTo(b.enrolledAt));
});

/// Resolution seam for a roster entry's student display name.
///
/// The student directory (`/api/students`, `/api/students/{id}`) is web-channel-only, so a
/// teacher session on mobile has no way to turn an enrolment's `student_id` into a name yet —
/// the same kind of known gap as `currentStudentIdProvider` on the student side. Resolves to
/// null (the roster row shows the student id) until a mobile-reachable resolver exists;
/// override in tests.
final rosterStudentNameProvider = Provider.family<String?, String>((ref, studentId) => null);

// ---------------------------------------------------------------------------
// Today's sessions — derived from the approved timetable
// ---------------------------------------------------------------------------

/// Today's teaching sessions for the signed-in teacher, drawn from the current term's approved
/// timetable version, nearest period first. Empty when the term has no approved timetable yet —
/// a legitimate "nothing scheduled" state, not an error.
final teacherTodaySessionsProvider = FutureProvider<List<TeacherSession>>((ref) async {
  final teacherId = await ref.watch(teacherIdProvider.future);
  final term = await ref.watch(currentTermProvider.future);
  final api = ref.watch(apiClientProvider);

  final versions = await api.timetable.listTimetableVersions(
    termId: term.id,
    status: Status11.approved,
    limit: 1,
  );
  if (versions.timetableVersions.isEmpty) return const [];

  final slotList = await api.timetable.listTimetableSlots(
    versionId: versions.timetableVersions.first.id,
    limit: 500,
  );

  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final mySlots = slotList.timetableSlots
      .where((slot) => slot.weekday == now.weekday && slot.teacherId == teacherId)
      .toList()
    ..sort((a, b) => a.period.compareTo(b.period));

  return Future.wait(
    mySlots.map((slot) async {
      final classInfo = await api.academics.getClass(classId: slot.classId);
      final sessions = await api.attendance.listAttendanceSessions(
        classId: slot.classId,
        sessionDate: today,
        limit: 50,
      );
      return TeacherSession(
        slot: slot,
        classCode: classInfo.code,
        attendance: SessionAttendanceState.fromSessions(
          sessions.attendanceSessions,
          slot.period,
        ),
      );
    }).toList(),
  );
});

// ---------------------------------------------------------------------------
// Grading queue — pending submissions across the teacher's assignments
// ---------------------------------------------------------------------------

/// Every published assignment across the classes the teacher leads.
final teacherPublishedAssignmentsProvider = FutureProvider<List<Assignment>>((ref) async {
  final classes = await ref.watch(teacherClassesProvider.future);
  final api = ref.watch(apiClientProvider);

  final pages = await Future.wait(
    classes.map((classInfo) => api.assignments.listAssignments(
          classId: classInfo.id,
          limit: 100,
        )),
  );
  return [
    for (final page in pages)
      ...page.assignments.where((a) => a.status == AssignmentStatus.published),
  ];
});

/// Turned-in submissions across the teacher's published assignments that still need a mark
/// (`grade_status = none`), newest first.
///
/// The API has no cross-assignment submission list, so this is one call per assignment. The
/// home screen's pending-count and recent-submissions cards both read this single provider
/// rather than each making its own pass.
final teacherPendingSubmissionsProvider = FutureProvider<List<PendingSubmission>>((ref) async {
  final assignments = await ref.watch(teacherPublishedAssignmentsProvider.future);
  final api = ref.watch(apiClientProvider);

  final pages = await Future.wait(
    assignments.map((assignment) async {
      final list = await api.submissions.listSubmissions(
        assignmentId: assignment.id,
        gradeStatus: GradeStatus.none,
        limit: 100,
      );
      return list.submissions
          .where((s) => s.submittedAt != null && s.status != SubmissionStatus.withdrawn)
          .map((s) => PendingSubmission(submission: s, assignment: assignment));
    }),
  );

  return [
    for (final page in pages) ...page,
  ]..sort((a, b) => b.submittedAt.compareTo(a.submittedAt));
});
