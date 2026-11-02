/// Raw HTTP helpers for the steps a journey has no mobile UI to drive — the same reason
/// `apps/web/e2e/critical/support/auth.ts` exists for the Playwright suite: several critical
/// steps are teacher/admin actions with no screen at all on the surface a given journey is
/// exercising, or (grade approval) a role this app doesn't have a shell for. These call the real
/// API with real Dio requests; nothing here is a stub.
library;

import 'package:dio/dio.dart';

import 'mock_idp.dart';
import 'personas.dart';

/// Bearer access token for [email] via the real mock OAuth mobile login round trip — the headless
/// counterpart to tapping "Continue with Mock" in the app.
Future<String> apiLoginAs(Dio dio, String email) async {
  final start = (await dio.get<Map<String, dynamic>>(
    '/api/auth/oauth/mock/mobile-start',
  )).data!;

  final authorizeUrl = buildMockAuthorizeUrl(
    apiBaseUrl: Uri.parse(dio.options.baseUrl),
    state: start['state'] as String,
    nonce: start['nonce'] as String,
    codeChallenge: start['code_challenge'] as String,
    loginHint: email,
  );
  final authCode = await resolveMockAuthorizationCode(dio, authorizeUrl);

  final exchanged = await dio.post<Map<String, dynamic>>(
    '/api/auth/oauth/mock/mobile-exchange',
    data: {'code': authCode.code, 'state': authCode.state, 'nonce': start['nonce']},
  );
  return exchanged.data!['access_token'] as String;
}

Options _bearer(String token) => Options(headers: {'Authorization': 'Bearer $token'});

class ScienceClass {
  ScienceClass({required this.id, required this.termId});

  final String id;
  final String termId;
}

/// Resolves the seeded Science class by its stable code (`db/seeds/data/academics.ts` gives it a
/// fresh uuid every seed run, so nothing can hardcode it) — a direct port of
/// `apps/web/e2e/critical/support/academics.ts`'s `resolveScienceClass`. Used by both the
/// attendance and grade-publish journeys, which both operate on this class.
Future<ScienceClass> resolveScienceClass(Dio dio, String accessToken) async {
  final response = await dio.get<Map<String, dynamic>>(
    '/api/academics/classes',
    queryParameters: {'limit': '100'},
    options: _bearer(accessToken),
  );
  final classes = response.data!['classes'] as List<dynamic>;
  final match = classes.cast<Map<String, dynamic>>().firstWhere(
        (c) => c['code'] == scienceClassCode,
        orElse: () => throw StateError('no seeded class with code $scienceClassCode found'),
      );
  return ScienceClass(id: match['id'] as String, termId: match['term_id'] as String);
}

/// Creates an invitation (admin-only, `POST /api/invitations`) and returns its raw one-time
/// activation token — the same way an E2E run with no inbox to check gets it (see
/// `activation-oauth-routes.ts`'s doc comment: the token is otherwise only ever delivered by
/// email).
Future<String> createInvitation(
  Dio dio, {
  required String adminToken,
  required String email,
  required String role,
}) async {
  final response = await dio.post<Map<String, dynamic>>(
    '/api/invitations',
    data: {'email': email, 'role': role},
    options: _bearer(adminToken),
  );
  return response.data!['token'] as String;
}

/// Verifies an invitation token's current lifecycle state (`GET
/// /api/auth/invitations/{token}/verify`), unauthenticated like the real invite-landing page's own
/// call.
Future<Response<Map<String, dynamic>>> verifyInvitation(Dio dio, String token) {
  return dio.get<Map<String, dynamic>>(
    '/api/auth/invitations/$token/verify',
    options: Options(validateStatus: (_) => true),
  );
}

/// Runs the mobile invitation-activation PKCE round trip against the mock provider (ST-247's
/// `mobile-activation-oauth-routes.ts` mock branch) — the mobile-app-shaped counterpart to the web
/// suite's browser-driven "Continue with Mock" click on `/invite/:token`. Returns the activation
/// response body (`status`, `access_token`, `refresh_token`, ...).
Future<Map<String, dynamic>> activateInvitationViaMock(
  Dio dio, {
  required String token,
  required String email,
}) async {
  final start = (await dio.get<Map<String, dynamic>>(
    '/api/auth/invitations/$token/oauth/mock/mobile-start',
  )).data!;

  final authorizeUrl = buildMockAuthorizeUrl(
    apiBaseUrl: Uri.parse(dio.options.baseUrl),
    state: start['state'] as String,
    nonce: start['nonce'] as String,
    codeChallenge: start['code_challenge'] as String,
    loginHint: email,
  );
  final authCode = await resolveMockAuthorizationCode(dio, authorizeUrl);

  final exchanged = await dio.post<Map<String, dynamic>>(
    '/api/auth/invitations/$token/oauth/mock/mobile-exchange',
    data: {'code': authCode.code, 'state': authCode.state, 'nonce': start['nonce']},
  );
  return exchanged.data!;
}

/// One entry of the `submissions` array `POST .../assessments` and `GET .../entry` both return.
class GradeSubmission {
  GradeSubmission({
    required this.id,
    required this.studentId,
    required this.status,
    required this.updatedAt,
    required this.grades,
  });

  factory GradeSubmission.fromJson(Map<String, dynamic> json) {
    return GradeSubmission(
      id: json['id'] as String,
      studentId: json['student_id'] as String,
      status: json['status'] as String,
      updatedAt: json['updated_at'] as String,
      grades: [
        for (final grade in json['grades'] as List<dynamic>)
          GradeRow.fromJson(grade as Map<String, dynamic>),
      ],
    );
  }

  final String id;
  final String studentId;
  final String status;
  final String updatedAt;
  final List<GradeRow> grades;
}

class GradeRow {
  GradeRow({required this.id, required this.label, required this.updatedAt});

  factory GradeRow.fromJson(Map<String, dynamic> json) {
    return GradeRow(
      id: json['id'] as String,
      label: json['label'] as String,
      updatedAt: json['updated_at'] as String,
    );
  }

  final String id;
  final String label;
  final String updatedAt;
}

/// Runs the API-only half of "grade submit -> approve -> publish"
/// (`apps/web/e2e/critical/grade-workflow.spec.ts`'s journey, ported): a teacher creates a fresh
/// assessment, scores one draft submission, and submits it. Grade entry and submission are
/// teacher-only and mobile-only, but this suite drives them through the API rather than the real
/// `GradeEntryScreen` — the realtime publish this journey is actually testing only needs a
/// *submitted* grade to approve, not a mobile-UI proof that entry itself works (that is
/// `test/features/teacher/...grade_entry...` unit/widget coverage's job).
///
/// Returns the submitted [GradeSubmission] and the fresh grade's label, so the caller can resolve
/// which student it belongs to and assert on that exact label after publish.
Future<(GradeSubmission submission, String label)> submitFreshGrade(
  Dio dio, {
  required String teacherToken,
  required String classId,
}) async {
  final gradebook = await dio.get<Map<String, dynamic>>(
    '/api/grades/gradebooks',
    queryParameters: {'classId': classId},
    options: _bearer(teacherToken),
  );
  final gradebookId = gradebook.data!['id'] as String;

  final label = 'Integration Test Quiz ${DateTime.now().microsecondsSinceEpoch}';
  final assessment = await dio.post<Map<String, dynamic>>(
    '/api/grades/gradebooks/$gradebookId/assessments',
    data: {'label': label, 'max_score': 100},
    options: _bearer(teacherToken),
  );
  final submissions = [
    for (final s in assessment.data!['submissions'] as List<dynamic>)
      GradeSubmission.fromJson(s as Map<String, dynamic>),
  ];
  final submission = submissions.firstWhere(
    (s) => s.status == 'draft',
    orElse: () => throw StateError('expected at least one draft submission after seeding drafts'),
  );
  final grade = submission.grades.firstWhere(
    (g) => g.label == label,
    orElse: () => throw StateError('expected a "$label" grade record on the draft submission'),
  );

  await dio.patch<void>(
    '/api/grades/gradebooks/$gradebookId/grades',
    data: {
      'grades': [
        {'id': grade.id, 'score': 88, 'updated_at': grade.updatedAt},
      ],
    },
    options: _bearer(teacherToken),
  );

  // Re-read the submission's own concurrency token: the score PATCH above touched a child grade
  // row, and submit's 409 GRADE_CONCURRENT_EDIT check is keyed on the *submission's* updated_at.
  final entry = await dio.get<Map<String, dynamic>>(
    '/api/grades/gradebooks/$gradebookId/entry',
    queryParameters: {'status': 'draft'},
    options: _bearer(teacherToken),
  );
  final freshDrafts = [
    for (final s in entry.data!['submissions'] as List<dynamic>)
      GradeSubmission.fromJson(s as Map<String, dynamic>),
  ];
  final freshSubmission = freshDrafts.firstWhere(
    (s) => s.id == submission.id,
    orElse: () => throw StateError('draft submission disappeared after scoring'),
  );

  final submitted = await dio.patch<Map<String, dynamic>>(
    '/api/grades/gradebooks/$gradebookId/submissions/${submission.id}/submit',
    data: {'updated_at': freshSubmission.updatedAt},
    options: _bearer(teacherToken),
  );
  if (submitted.data!['status'] != 'submitted') {
    throw StateError('expected submission to move to submitted, got ${submitted.data}');
  }

  return (submission, label);
}

/// Approves [submissionId] via the admin approval queue (`POST /api/approvals/bulk-decision`) —
/// per `grade-entry-service.ts`, approving *is* publishing, one atomic transition. The "Approval
/// Queue" tag is excluded from codegen (a swagger_parser name-collision bug — see
/// `pubspec.yaml`'s `exclude_tags` comment), so this is a hand-written call like every other
/// excluded-tag surface in this app.
Future<void> approveGradeSubmission(
  Dio dio, {
  required String adminToken,
  required String submissionId,
}) async {
  await dio.post<void>(
    '/api/approvals/bulk-decision',
    data: {
      'items': [
        {'item_type': 'grade_submission', 'id': submissionId, 'action': 'approve'},
      ],
    },
    options: _bearer(adminToken),
  );
}

/// Resolves a seeded student's id by full name (admin-only, `GET /api/students?search=`) — used
/// where a journey needs a persona's student id but only knows their [personaEmailFor]-shaped
/// email (there is no reverse "student id by email" lookup; `search` matches name instead).
Future<String> findStudentIdByName(
  Dio dio, {
  required String adminToken,
  required String firstName,
  required String lastName,
}) async {
  final response = await dio.get<Map<String, dynamic>>(
    '/api/students',
    queryParameters: {'search': '$firstName $lastName'},
    options: _bearer(adminToken),
  );
  final students = (response.data!['students'] as List<dynamic>).cast<Map<String, dynamic>>();
  final match = students.firstWhere(
    (s) => s['first_name'] == firstName && s['last_name'] == lastName,
    orElse: () => throw StateError('no seeded student named $firstName $lastName found'),
  );
  return match['id'] as String;
}

/// Resolves a student's profile (admin-only) so the caller can compute their mock login_hint via
/// [personaEmailFor] — mirrors the web spec's identical final step.
Future<({String firstName, String lastName})> studentProfile(
  Dio dio, {
  required String adminToken,
  required String studentId,
}) async {
  final response = await dio.get<Map<String, dynamic>>(
    '/api/students/$studentId',
    options: _bearer(adminToken),
  );
  return (
    firstName: response.data!['first_name'] as String,
    lastName: response.data!['last_name'] as String,
  );
}
