import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/auth_providers.dart';

/// Resolution seam for "which [StudentProfile] is the signed-in session" — a genuine, currently
/// unfillable gap, not an oversight:
///
///   * There is no `/api/students/me` (the STUDENT-role counterpart to `/api/teachers/me` —
///     `core/api/generated/teachers/teachers_client.dart`).
///   * `StudentsClient.listStudents` has no `user_id` filter to self-resolve a [StudentProfile]
///     from the session's own [AuthSession.userId] (`sub` claim) either.
///
/// Until one of those exists, this resolves to null. [todayGradesProvider] and
/// [todayTimetableProvider] (`today_providers.dart`) treat null as
/// [TodaySectionUnavailable](`../domain/today_section.dart`) rather than guessing an id — an
/// honest "not available yet" beats a silently wrong request. Override this provider once a
/// resolution path ships, or in tests — same seam shape as `realtimeTokenProvider`
/// (`core/realtime/realtime_providers.dart`).
final currentStudentIdProvider = Provider<String?>((ref) {
  ref.watch(authSessionProvider);
  return null;
});

/// Resolution seam for "which classes is the signed-in student actively enrolled in" —
/// `today_timetable_provider`'s other missing input. Even with [currentStudentIdProvider]
/// resolved, there is no self-scoped enrollments endpoint: `listEnrollments` only lists by
/// class, so finding "my classes" would mean fetching enrollments for every class in the
/// school and filtering client-side — not a real solution, so this stays an explicit gap
/// instead. Empty (never guessed) until a resolution path exists; override for tests the same
/// way as [currentStudentIdProvider].
final currentEnrolledClassIdsProvider = Provider<List<String>>((ref) => const []);
