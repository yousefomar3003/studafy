import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/studafy_api_client.dart';
import 'package:studafy_mobile/src/core/api/generated/academics/academics_client.dart';
import 'package:studafy_mobile/src/core/api/generated/assignments/assignments_client.dart';
import 'package:studafy_mobile/src/core/api/generated/attendance/attendance_client.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_session.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_session_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/class.dart';
import 'package:studafy_mobile/src/core/api/generated/models/class_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/course.dart';
import 'package:studafy_mobile/src/core/api/generated/models/enrollment.dart';
import 'package:studafy_mobile/src/core/api/generated/models/enrollment_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/status10.dart';
import 'package:studafy_mobile/src/core/api/generated/models/status11.dart';
import 'package:studafy_mobile/src/core/api/generated/models/status12.dart';
import 'package:studafy_mobile/src/core/api/generated/models/status13.dart';
import 'package:studafy_mobile/src/core/api/generated/models/status9.dart';
import 'package:studafy_mobile/src/core/api/generated/models/submission.dart';
import 'package:studafy_mobile/src/core/api/generated/models/submission_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/grade_status.dart';
import 'package:studafy_mobile/src/core/api/generated/submissions/submissions_client.dart';
import 'package:studafy_mobile/src/core/api/generated/models/teacher_profile.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_slot.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_slot_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_version.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_version_list.dart';
import 'package:studafy_mobile/src/core/api/generated/teachers/teachers_client.dart';
import 'package:studafy_mobile/src/core/api/generated/timetable/timetable_client.dart';

// ---------------------------------------------------------------------------
// Model fixtures — built via fromJson so a new field on a model doesn't break these
// ---------------------------------------------------------------------------

const _t0 = '2026-01-01T00:00:00.000Z';

TeacherProfile teacherProfile({String id = 'teacher-1'}) => TeacherProfile.fromJson({
      'id': id,
      'school_id': 'school-1',
      'user_id': 'user-1',
      'employee_number': 'EMP-1',
      'employment_status': 'active',
      'hire_date': null,
      'termination_date': null,
      'created_at': _t0,
      'updated_at': _t0,
    });

Class classFixture({
  required String id,
  required String code,
  String courseId = 'course-1',
  String leadTeacherId = 'teacher-1',
}) =>
    Class.fromJson({
      'id': id,
      'school_id': 'school-1',
      'course_id': courseId,
      'academic_year_id': 'year-1',
      'term_id': 'term-1',
      'lead_teacher_id': leadTeacherId,
      'room_id': 'room-1',
      'code': code,
      'capacity': 30,
      'status': 'active',
      'created_at': _t0,
      'updated_at': _t0,
    });

Course courseFixture({String id = 'course-1', String name = 'Mathematics'}) =>
    Course.fromJson({'id': id, 'code': 'MATH101', 'name': name, 'credit_hours': 3});

Enrollment enrollmentFixture({
  required String studentId,
  String classId = 'class-1',
  String enrolledAt = _t0,
}) =>
    Enrollment.fromJson({
      'school_id': 'school-1',
      'class_id': classId,
      'student_id': studentId,
      'status': 'active',
      'enrolled_at': enrolledAt,
      'withdrawn_at': null,
      'created_at': _t0,
      'updated_at': _t0,
    });

TimetableVersion approvedVersion({String id = 'version-1'}) => TimetableVersion.fromJson({
      'id': id,
      'school_id': 'school-1',
      'academic_year_id': 'year-1',
      'term_id': 'term-1',
      'name': 'v1',
      'status': 'approved',
      'submitted_at': null,
      'submitted_by_user_id': null,
      'approved_at': _t0,
      'approved_by_user_id': 'admin-1',
      'rejected_reason': null,
      'created_at': _t0,
      'updated_at': _t0,
    });

TimetableSlot slotFixture({
  required String id,
  required String classId,
  required String teacherId,
  required int weekday,
  required int period,
}) =>
    TimetableSlot.fromJson({
      'id': id,
      'school_id': 'school-1',
      'timetable_version_id': 'version-1',
      'class_id': classId,
      'teacher_id': teacherId,
      'room_id': 'room-1',
      'weekday': weekday,
      'period': period,
      'created_at': _t0,
      'updated_at': _t0,
    });

AttendanceSession attendanceSession({
  required String classId,
  required String status,
  int? period,
}) =>
    AttendanceSession.fromJson({
      'id': 'session-$classId-$period',
      'school_id': 'school-1',
      'class_id': classId,
      'session_date': _t0,
      'period': period,
      'status': status,
      'taken_by_user_id': 'user-1',
      'created_at': _t0,
      'updated_at': _t0,
    });

Assignment assignmentFixture({
  required String id,
  required String classId,
  String title = 'Worksheet',
  String status = 'published',
}) =>
    Assignment.fromJson({
      'id': id,
      'school_id': 'school-1',
      'class_id': classId,
      'subject_id': 'subject-1',
      'title': title,
      'description': null,
      'instructions': null,
      'status': status,
      'available_from': null,
      'assigned_at': _t0,
      'due_at': _t0,
      'max_score': 100,
      'allow_late_submission': true,
      'attachments': <Object?>[],
      'created_by_user_id': 'teacher-1',
      'last_edited_by_user_id': 'teacher-1',
      'created_at': _t0,
      'updated_at': _t0,
    });

Submission submissionFixture({
  required String id,
  required String assignmentId,
  required String studentId,
  DateTime? submittedAt,
  String status = 'submitted',
  bool isLate = false,
}) =>
    Submission.fromJson({
      'id': id,
      'school_id': 'school-1',
      'assignment_id': assignmentId,
      'student_id': studentId,
      'content': 'answer',
      'status': status,
      'grade_status': 'none',
      'is_late': isLate,
      'attempt_number': 1,
      'submitted_at': (submittedAt ?? DateTime.parse(_t0)).toUtc().toIso8601String(),
      'score': null,
      'feedback': null,
      'graded_at': null,
      'graded_by_user_id': null,
      'attachments': <Object?>[],
      'last_edited_by_user_id': 'student-1',
      'created_at': _t0,
      'updated_at': _t0,
    });

// ---------------------------------------------------------------------------
// Fake domain clients — only the methods the teacher providers call are implemented
// ---------------------------------------------------------------------------

class FakeTeachersClient extends Fake implements TeachersClient {
  FakeTeachersClient(this._profile);

  final TeacherProfile _profile;

  @override
  Future<TeacherProfile> getTeacherMe() async => _profile;
}

class FakeAcademicsClient extends Fake implements AcademicsClient {
  FakeAcademicsClient({
    this.classes = const [],
    this.coursesById = const {},
    this.enrollmentsByClassId = const {},
  });

  List<Class> classes;
  Map<String, Course> coursesById;
  Map<String, List<Enrollment>> enrollmentsByClassId;

  String? lastLeadTeacherId;

  @override
  Future<ClassList> listClasses({
    Status9? status,
    String? courseId,
    String? termId,
    String? leadTeacherId,
    int? limit = 20,
    int? offset = 0,
  }) async {
    lastLeadTeacherId = leadTeacherId;
    final filtered = leadTeacherId == null
        ? classes
        : classes.where((c) => c.leadTeacherId == leadTeacherId).toList();
    return ClassList(classes: filtered, total: filtered.length);
  }

  @override
  Future<Class> getClass({required String classId}) async =>
      classes.firstWhere((c) => c.id == classId);

  @override
  Future<Course> getCourse({required String courseId}) async => coursesById[courseId]!;

  @override
  Future<EnrollmentList> listEnrollments({
    required String classId,
    Status10? status,
    int? limit = 20,
    int? offset = 0,
  }) async {
    final rows = enrollmentsByClassId[classId] ?? const [];
    return EnrollmentList(enrollments: rows, total: rows.length);
  }
}

class FakeTimetableClient extends Fake implements TimetableClient {
  FakeTimetableClient({this.versions = const [], this.slots = const []});

  List<TimetableVersion> versions;
  List<TimetableSlot> slots;

  @override
  Future<TimetableVersionList> listTimetableVersions({
    String? termId,
    Status11? status,
    int? limit = 20,
    int? offset = 0,
  }) async =>
      TimetableVersionList(timetableVersions: versions, total: versions.length);

  @override
  Future<TimetableSlotList> listTimetableSlots({
    required String versionId,
    int? limit = 20,
    int? offset = 0,
  }) async =>
      TimetableSlotList(timetableSlots: slots, total: slots.length);
}

class FakeAttendanceClient extends Fake implements AttendanceClient {
  FakeAttendanceClient({this.sessionsByClassId = const {}});

  Map<String, List<AttendanceSession>> sessionsByClassId;

  @override
  Future<AttendanceSessionList> listAttendanceSessions({
    String? classId,
    DateTime? sessionDate,
    int? limit = 20,
    int? offset = 0,
  }) async {
    final rows = sessionsByClassId[classId] ?? const [];
    return AttendanceSessionList(attendanceSessions: rows, total: rows.length);
  }
}

class FakeAssignmentsClient extends Fake implements AssignmentsClient {
  FakeAssignmentsClient({this.byClassId = const {}});

  Map<String, List<Assignment>> byClassId;

  @override
  Future<AssignmentList> listAssignments({
    String? cursor,
    String? classId,
    String? subjectId,
    Status12? status,
    int? limit = 20,
  }) async {
    final rows = byClassId[classId] ?? const [];
    return AssignmentList(assignments: rows, nextCursor: null);
  }
}

class FakeSubmissionsClient extends Fake implements SubmissionsClient {
  FakeSubmissionsClient({this.byAssignmentId = const {}});

  Map<String, List<Submission>> byAssignmentId;

  @override
  Future<SubmissionList> listSubmissions({
    required String assignmentId,
    Status13? status,
    GradeStatus? gradeStatus,
    String? studentId,
    int? limit = 20,
    int? offset = 0,
  }) async {
    final rows = byAssignmentId[assignmentId] ?? const [];
    return SubmissionList(submissions: rows, total: rows.length);
  }
}

/// A [StudafyApiClient] whose domain-client getters return the fakes above; every other getter
/// throws (via [Fake]) so a test that reaches an unstubbed corner of the API fails loudly.
class FakeStudafyApiClient extends Fake implements StudafyApiClient {
  FakeStudafyApiClient({
    FakeTeachersClient? teachers,
    FakeAcademicsClient? academics,
    FakeTimetableClient? timetable,
    FakeAttendanceClient? attendance,
    FakeAssignmentsClient? assignments,
    FakeSubmissionsClient? submissions,
  })  : teachers = teachers ?? FakeTeachersClient(teacherProfile()),
        academics = academics ?? FakeAcademicsClient(),
        timetable = timetable ?? FakeTimetableClient(),
        attendance = attendance ?? FakeAttendanceClient(),
        assignments = assignments ?? FakeAssignmentsClient(),
        submissions = submissions ?? FakeSubmissionsClient();

  @override
  final FakeTeachersClient teachers;
  @override
  final FakeAcademicsClient academics;
  @override
  final FakeTimetableClient timetable;
  @override
  final FakeAttendanceClient attendance;
  @override
  final FakeAssignmentsClient assignments;
  @override
  final FakeSubmissionsClient submissions;
}
