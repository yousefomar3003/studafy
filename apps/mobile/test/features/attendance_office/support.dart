import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/core/api/generated/models/academic_year.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_record.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_session.dart';
import 'package:studafy_mobile/src/core/api/generated/models/class.dart';
import 'package:studafy_mobile/src/core/api/generated/models/term.dart';
import 'package:studafy_mobile/src/features/attendance_office/data/attendance_office_client.dart';
import 'package:studafy_mobile/src/features/attendance_office/domain/attendance_office.dart';

const _t0 = '2026-01-01T00:00:00.000Z';

AcademicYear yearFixture({String id = 'year-1', String status = 'active'}) =>
    AcademicYear.fromJson({
      'id': id,
      'school_id': 'school-1',
      'code': '2026',
      'name': '2026/27',
      'starts_on': '2026-09-01',
      'ends_on': '2027-06-30',
      'status': status,
      'created_at': _t0,
      'updated_at': _t0,
    });

Term termFixture({
  String id = 'term-1',
  String name = 'Term 1',
  String startsOn = '2026-09-01',
  String endsOn = '2026-12-20',
}) => Term.fromJson({
  'id': id,
  'school_id': 'school-1',
  'academic_year_id': 'year-1',
  'code': id,
  'name': name,
  'sequence_number': 1,
  'starts_on': startsOn,
  'ends_on': endsOn,
  'status': 'active',
  'created_at': _t0,
  'updated_at': _t0,
});

Class officeClass({
  required String id,
  required String code,
  String status = 'active',
}) => Class.fromJson({
  'id': id,
  'school_id': 'school-1',
  'course_id': 'course-1',
  'academic_year_id': 'year-1',
  'term_id': 'term-1',
  'lead_teacher_id': 'teacher-1',
  'room_id': 'room-1',
  'code': code,
  'capacity': 30,
  'status': status,
  'created_at': _t0,
  'updated_at': _t0,
});

AttendanceSession dailySession({
  required String classId,
  required String status,
  String? id,
}) => AttendanceSession.fromJson({
  'id': id ?? 'session-$classId',
  'school_id': 'school-1',
  'class_id': classId,
  'session_date': '2026-10-13',
  'period': null,
  'status': status,
  'taken_by_user_id': 'user-1',
  'created_at': _t0,
  'updated_at': _t0,
});

AttendanceRecord recordFixture({
  required String studentId,
  required String sessionId,
  String status = 'present',
  int? minutesLate,
}) => AttendanceRecord.fromJson({
  'id': 'rec-$studentId',
  'school_id': 'school-1',
  'attendance_session_id': sessionId,
  'student_id': studentId,
  'status': status,
  'minutes_late': minutesLate,
  'reason': null,
  'recorded_by_user_id': 'user-1',
  'created_at': _t0,
});

/// A DioException carrying an API problem with [code], as `ErrorMappingInterceptor` builds it.
DioException apiErrorFor(String code, {int status = 409}) {
  final options = RequestOptions(path: '/');
  return DioException(
    requestOptions: options,
    response: Response(requestOptions: options, statusCode: status),
    error: ApiException(status: status, title: code, code: code),
  );
}

/// In-memory [AttendanceOfficeClient] that logs every write in [calls], in order.
class FakeAttendanceOfficeClient extends Fake
    implements AttendanceOfficeClient {
  FakeAttendanceOfficeClient({
    List<AcademicYear>? years,
    List<Term>? terms,
    this.classes = const [],
    Map<String, AttendanceSession>? sessions,
    this.rosters = const {},
    this.names = const {},
    Map<String, List<AttendanceRecord>>? records,
  }) : years = years ?? [yearFixture()],
       terms = terms ?? [termFixture()],
       sessions = sessions ?? {},
       records = records ?? {};

  List<AcademicYear> years;
  List<Term> terms;
  List<Class> classes;
  Map<String, AttendanceSession> sessions;
  Map<String, List<String>> rosters;
  Map<String, String> names;
  Map<String, List<AttendanceRecord>> records;

  /// `open:<class>`, `status:<session>:<status>`, `batch:<session>:<n>` — in call order.
  final List<String> calls = [];

  /// Every batch body sent, in order.
  final List<List<Map<String, Object?>>> batches = [];

  Object? throwOnRead;
  Object? throwOnWrite;
  bool namesFail = false;

  @override
  Future<List<AcademicYear>> listAcademicYears() async {
    if (throwOnRead != null) throw throwOnRead!;
    return years;
  }

  @override
  Future<List<Term>> listTerms(String yearId) async => terms;

  @override
  Future<List<Class>> listClasses(String termId) async => classes;

  @override
  Future<Map<String, AttendanceSession>> listDailySessions(
    DateTime date,
  ) async => {
    for (final entry in sessions.entries)
      if (entry.value.status.json != 'cancelled') entry.key: entry.value,
  };

  @override
  Future<List<String>> listRoster(String classId) async =>
      rosters[classId] ?? const [];

  @override
  Future<Map<String, String>> listStudentNames(String classId) async {
    if (namesFail) throw apiErrorFor('AUTHZ_FORBIDDEN', status: 403);
    return names;
  }

  @override
  Future<List<AttendanceRecord>> listSessionRecords(String sessionId) async =>
      records[sessionId] ?? const [];

  @override
  Future<AttendanceSession> openSession({
    required String classId,
    required DateTime date,
  }) async {
    if (throwOnWrite != null) throw throwOnWrite!;
    calls.add('open:$classId');
    return sessions[classId] ??= dailySession(classId: classId, status: 'open');
  }

  @override
  Future<AttendanceSession> updateSessionStatus(
    String sessionId,
    String status,
  ) async {
    if (throwOnWrite != null) throw throwOnWrite!;
    calls.add('status:$sessionId:$status');
    final entry = sessions.entries.firstWhere((e) => e.value.id == sessionId);
    final updated = dailySession(
      classId: entry.key,
      status: status,
      id: sessionId,
    );
    sessions[entry.key] = updated;
    return updated;
  }

  @override
  Future<void> recordBatch(
    String sessionId,
    List<OfficeBatchItem> items,
  ) async {
    if (throwOnWrite != null) throw throwOnWrite!;
    calls.add('batch:$sessionId:${items.length}');
    batches.add([for (final item in items) item.toJson()]);
    records[sessionId] = [
      ...?records[sessionId],
      for (final item in items)
        recordFixture(
          studentId: item.studentId,
          sessionId: sessionId,
          status: item.status.wireStatus.json!,
          minutesLate: item.minutesLate,
        ),
    ];
  }
}
