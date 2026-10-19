import 'dart:math' as math;

import 'package:dio/dio.dart';

import '../../../core/api/fetch_all_pages.dart';
import '../../../core/api/generated/models/academic_year.dart';
import '../../../core/api/generated/models/attendance_record.dart';
import '../../../core/api/generated/models/attendance_session.dart';
import '../../../core/api/generated/models/attendance_session_status.dart';
import '../../../core/api/generated/models/class.dart';
import '../../../core/api/generated/models/term.dart';
import '../domain/attendance_office.dart';

/// Largest `records` array `POST /api/attendance/records/batch` accepts in one call.
const int officeBatchSize = 50;

/// Hand-written client for the attendance office's reads and writes — the endpoints behind
/// `apps/web/src/features/attendance-office/queries.ts`.
///
/// Not the generated client, for two reasons: its `listAttendanceSessions` serialises
/// `session_date` as a full date-time (the API's date-only filter rejects it), and it predates `GET /api/attendance/sessions/{id}/records`.
/// Regenerating it today renumbers the positional `StatusN` query enums and breaks unrelated
/// callers, so this stays on its own [Dio] (wired like `gradeEntryClientProvider`) until the
/// client is regenerated deliberately. Responses are still parsed with the generated models.
///
/// Every method throws the shared `ApiException` (via `DioException.apiError`) on a non-2xx.
class AttendanceOfficeClient {
  AttendanceOfficeClient(this._dio);

  final Dio _dio;

  // --- Academic structure --------------------------------------------------

  Future<List<AcademicYear>> listAcademicYears() async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/academics/years',
      queryParameters: {'limit': apiMaxPageSize},
    );
    return [
      for (final row in _list(response.data, 'academic_years'))
        AcademicYear.fromJson(row),
    ];
  }

  Future<List<Term>> listTerms(String yearId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/academics/years/$yearId/terms',
      queryParameters: {'limit': apiMaxPageSize},
    );
    return [
      for (final row in _list(response.data, 'terms')) Term.fromJson(row),
    ];
  }

  /// Every class in [termId], whatever its status — the caller drops cancelled ones.
  Future<List<Class>> listClasses(String termId) {
    return fetchAllPages((limit, offset) async {
      final response = await _dio.get<Map<String, Object?>>(
        '/api/academics/classes',
        queryParameters: {'term_id': termId, 'limit': limit, 'offset': offset},
      );
      return (
        rows: [
          for (final row in _list(response.data, 'classes'))
            Class.fromJson(row),
        ],
        total: _total(response.data),
      );
    });
  }

  /// Student ids actively enrolled in [classId].
  Future<List<String>> listRoster(String classId) {
    return fetchAllPages((limit, offset) async {
      final response = await _dio.get<Map<String, Object?>>(
        '/api/academics/classes/$classId/enrollments',
        queryParameters: {'status': 'active', 'limit': limit, 'offset': offset},
      );
      return (
        rows: [
          for (final row in _list(response.data, 'enrollments'))
            row['student_id']! as String,
        ],
        total: _total(response.data),
      );
    });
  }

  /// Display names for [classId]'s actively enrolled students, keyed by student id
  /// (`GET /api/attendance/classes/{classId}/roster`). That roster is served on mobile, unlike the
  /// web-only student directory, and carries names only.
  Future<Map<String, String>> listStudentNames(String classId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/attendance/classes/$classId/roster',
    );
    return {
      for (final row in _list(response.data, 'students'))
        row['id']! as String: row['name']! as String,
    };
  }

  // --- Attendance ---------------------------------------------------------

  /// Every daily register (period null, not cancelled) opened in the school on [date], keyed by
  /// class id.
  Future<Map<String, AttendanceSession>> listDailySessions(
    DateTime date,
  ) async {
    final byClass = <String, AttendanceSession>{};
    for (var page = 0; page < 50; page++) {
      final response = await _dio.get<Map<String, Object?>>(
        '/api/attendance/sessions',
        queryParameters: {
          'session_date': ymd(date),
          'limit': apiMaxPageSize,
          'offset': page * apiMaxPageSize,
        },
      );
      final rows = _list(response.data, 'attendance_sessions');
      for (final row in rows) {
        final session = AttendanceSession.fromJson(row);
        if (session.period == null &&
            session.status != AttendanceSessionStatus.cancelled) {
          byClass[session.classId] = session;
        }
      }
      if (rows.length < apiMaxPageSize) break;
    }
    return byClass;
  }

  Future<List<AttendanceRecord>> listSessionRecords(String sessionId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/attendance/sessions/$sessionId/records',
    );
    return [
      for (final row in _list(response.data, 'records'))
        AttendanceRecord.fromJson(row),
    ];
  }

  /// Opens (or returns the existing) daily session for [classId] on [date].
  Future<AttendanceSession> openSession({
    required String classId,
    required DateTime date,
  }) async {
    final response = await _dio.post<Map<String, Object?>>(
      '/api/attendance/sessions',
      data: {'class_id': classId, 'session_date': ymd(date)},
    );
    return AttendanceSession.fromJson(response.data!);
  }

  /// `PATCH /api/attendance/sessions/{id}` — `open` (from draft) or `submitted` (from open).
  Future<AttendanceSession> updateSessionStatus(
    String sessionId,
    String status,
  ) async {
    final response = await _dio.patch<Map<String, Object?>>(
      '/api/attendance/sessions/$sessionId',
      data: {'status': status},
    );
    return AttendanceSession.fromJson(response.data!);
  }

  /// Records up to [officeBatchSize] students. Idempotent per student: already-recorded ones are
  /// skipped server-side.
  Future<void> recordBatch(
    String sessionId,
    List<OfficeBatchItem> records,
  ) async {
    await _dio.post<Map<String, Object?>>(
      '/api/attendance/records/batch',
      data: {
        'attendance_session_id': sessionId,
        'records': [for (final record in records) record.toJson()],
      },
    );
  }
}

/// Thrown by [submitOfficeRegister] when the class's register for that date was cancelled.
class RegisterCancelledException implements Exception {
  const RegisterCancelledException();
}

/// Saves a register in one go — the mobile twin of the web's `useSubmitRegister`: open (or reuse)
/// the daily session, move a draft to `open`, record [records] in batches of [officeBatchSize],
/// then submit. Every step is idempotent server-side, so retrying after a partial failure
/// finishes the job rather than duplicating it. Returns the session id.
Future<String> submitOfficeRegister(
  AttendanceOfficeClient client, {
  required String classId,
  required DateTime date,
  required AttendanceSession? existingSession,
  required List<OfficeBatchItem> records,
}) async {
  var session =
      existingSession ?? await client.openSession(classId: classId, date: date);

  switch (session.status) {
    case AttendanceSessionStatus.cancelled:
      throw const RegisterCancelledException();
    case AttendanceSessionStatus.submitted:
    case AttendanceSessionStatus.locked:
      return session.id;
    case AttendanceSessionStatus.draft:
      session = await client.updateSessionStatus(session.id, 'open');
    case AttendanceSessionStatus.open:
    case AttendanceSessionStatus.$unknown:
      break;
  }

  for (var start = 0; start < records.length; start += officeBatchSize) {
    await client.recordBatch(
      session.id,
      records.sublist(start, math.min(start + officeBatchSize, records.length)),
    );
  }

  await client.updateSessionStatus(session.id, 'submitted');
  return session.id;
}

List<Map<String, Object?>> _list(Map<String, Object?>? body, String key) => [
  for (final row in (body?[key] as List<Object?>?) ?? const <Object?>[])
    Map<String, Object?>.from(row! as Map),
];

int _total(Map<String, Object?>? body) =>
    (body?['total'] as num?)?.toInt() ?? 0;
