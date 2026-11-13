import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';

import 'support/api_helpers.dart';
import 'support/personas.dart';
import 'support/test_app.dart';

/// Journey 4/5 (ST-247): grade view live-updates on a publish event.
///
/// Unskipped by QA-14. It was skipped while the app sent its RS256 access token to a gateway that
/// only verified HS256 stub tokens, so no real session could open a socket. The app now fetches a
/// handshake ticket from `GET /api/realtime/ticket` (`core/realtime/realtime_ticket.dart`), which the
/// gateway verifies, so this journey exercises the real production wiring end to end.
///
/// Also overrides `currentStudentIdProvider` to the resolved student's real id — the documented,
/// test-sanctioned seam for a *separate* currently-unfillable gap (no self-resolving
/// `/students/me`), not related to why this test is skipped.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'a published grade appears on the open grades screen without a manual refresh',
    (tester) async {
      final appConfig = integrationTestAppConfig();
      final dio = Dio(BaseOptions(baseUrl: appConfig.apiBaseUrl.toString()));

      final teacherToken = await apiLoginAs(dio, Personas.scienceTeacher);
      final scienceClass = await resolveScienceClass(dio, teacherToken);
      final (submission, label) = await submitFreshGrade(
        dio,
        teacherToken: teacherToken,
        classId: scienceClass.id,
      );

      final adminToken = await apiLoginAs(dio, Personas.orgAdmin);
      final student = await studentProfile(
        dio,
        adminToken: adminToken,
        studentId: submission.studentId,
      );
      final studentEmail = personaEmailFor(student.firstName, student.lastName);

      final app = await IntegrationTestApp.pump(
        tester,
        mockLoginHint: studentEmail,
        extraOverrides: [
          currentStudentIdProvider.overrideWithValue(submission.studentId),
        ],
      );
      await app.signInWithMock(tester);

      // The student shell's Home tab already renders "Today"'s grades card off the same realtime
      // subscription `today_providers.dart` documents — no extra navigation needed.
      await approveGradeSubmission(
        dio,
        adminToken: adminToken,
        submissionId: submission.id,
      );

      await pumpUntil(tester, () => find.text(label).evaluate().isNotEmpty);
      expect(find.text(label), findsOneWidget);
    },
  );
}
