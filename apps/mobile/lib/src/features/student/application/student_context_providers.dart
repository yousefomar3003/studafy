import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/generated/models/student_self.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/auth/auth_state.dart';

/// The signed-in student's own record, from `GET /api/students/me` — the STUDENT-role counterpart
/// to `/api/teachers/me` (`teacher_providers.dart`'s `teacherIdProvider`).
///
/// The endpoint is resolved server-side from the session's own user (never a client-supplied id),
/// is reachable on the mobile channel, and needs no `STUDENT_READ`; it carries the student's id
/// and the ids of the active classes they're actively enrolled in, so one call feeds both
/// [currentStudentIdProvider] and [currentEnrolledClassIdsProvider].
///
/// Fetched once per authenticated session: a plain (non-autoDispose) provider that re-resolves
/// whenever [authStatusProvider] changes, so a different account signing in on the same device
/// never sees the previous student's record. Null while signed out, and null when the caller has
/// no student record in this school (404 — e.g. a parent or teacher session), which the
/// consumers treat as "not available" rather than an error. Any other failure (offline, 5xx)
/// surfaces as [AsyncError] and is retried by Riverpod's default provider retry.
final currentStudentSelfProvider = FutureProvider<StudentSelf?>((ref) async {
  if (ref.watch(authStatusProvider) != AuthStatus.authenticated) return null;

  try {
    return await ref.watch(apiClientProvider).students.getStudentMe();
  } on DioException catch (error) {
    final status = error.apiError?.status ?? error.response?.statusCode;
    if (status == 404) return null;
    rethrow;
  }
});

/// Which student record the signed-in session is, from [currentStudentSelfProvider].
///
/// Null until that resolves (loading, signed out, offline, or not a student).
/// [todayGradesProvider] and [todayTimetableProvider] (`today_providers.dart`) treat null as
/// [TodaySectionUnavailable](`../domain/today_section.dart`) rather than guessing an id, and
/// rebuild with the real id the moment it arrives. Override with a fixed value in tests — same
/// seam shape as `realtimeTokenProvider` (`core/realtime/realtime_providers.dart`).
final currentStudentIdProvider = Provider<String?>((ref) {
  return ref.watch(currentStudentSelfProvider).value?.id;
});

/// The active classes the signed-in student is actively enrolled in, from
/// [currentStudentSelfProvider] (server-filtered: enrollment and class both `active`, ids sorted).
///
/// Empty (never guessed) until that resolves, and empty for a student with no current
/// enrollments; consumers treat both as "nothing to show". Override for tests the same way as
/// [currentStudentIdProvider].
final currentEnrolledClassIdsProvider = Provider<List<String>>((ref) {
  return ref.watch(currentStudentSelfProvider).value?.enrolledClassIds ??
      const [];
});
