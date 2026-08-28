import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/attendance_history.dart';
import 'student_context_providers.dart';

/// Resolution seam for the signed-in student's own attendance records — a genuine, currently
/// unfillable gap, the same kind as [currentStudentIdProvider]
/// (`student_context_providers.dart`), not an oversight:
///
///   * There is no student-facing attendance endpoint. `AttendanceClient.listAttendanceSessions`
///     lists sessions by class, never by student, and returns no records; the per-record routes
///     (`correctAttendanceRecord`, `getAttendanceRecordHistory`) are teacher/principal
///     correction tools gated on scopes a STUDENT session on mobile does not hold.
///
/// Until a self-scoped route ships (a `GET /api/students/{id}/attendance`, the STUDENT-role
/// counterpart to the principal monitoring report), this resolves to null and the screen
/// renders [AttendanceHistoryUnavailable] — an honest "not available yet" over a guessed
/// request. Override in tests, or here once a resolution path exists — same seam shape as
/// [currentStudentIdProvider].
final studentAttendanceRecordsProvider =
    FutureProvider.autoDispose<List<StudentAttendanceEntry>?>((ref) async {
      ref.watch(currentStudentIdProvider);
      return null;
    });

/// The attendance screen's assembled state: months newest-first, each with its own summary, or
/// [AttendanceHistoryUnavailable] when the records seam is unresolved.
///
/// A thin [FutureProvider] over [studentAttendanceRecordsProvider] so the ready/unavailable
/// branch is decided in one place and the widget only ever sees an `AsyncValue`
/// of [AttendanceHistoryStatus] — loading and error pass straight through.
final attendanceHistoryProvider =
    FutureProvider.autoDispose<AttendanceHistoryStatus>((ref) async {
      final entries = await ref.watch(studentAttendanceRecordsProvider.future);
      if (entries == null) {
        return const AttendanceHistoryUnavailable();
      }
      return AttendanceHistoryReady(assembleAttendanceHistory(entries: entries));
    });
