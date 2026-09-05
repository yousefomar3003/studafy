import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';

import 'support/api_helpers.dart';
import 'support/personas.dart';
import 'support/test_app.dart';

/// Journey 4/5 (ST-247): grade view live-updates on a publish event.
///
/// SKIPPED — not flaky, genuinely blocked. `bootstrapApp` wires the realtime handshake token to
/// the session's real RS256 access token (`realtimeTokenProvider.overrideWithValue(() =>
/// session.tokenProvider)`), but `apps/realtime/src/auth.ts` only verifies its own HS256 stub
/// tokens signed with `WS_JWT_SECRET` — a documented, deliberately deferred gap (see that file's
/// header: "there is no real identity provider yet... replace signToken... in the ticket that
/// wires up real authentication"). A mobile session's real bearer token is therefore rejected by
/// the gateway with `TOKEN_INVALID` in every environment today, dev included — not a test
/// environment quirk. `grade_providers.dart`'s `grades.published` live-refresh can never fire
/// without a working handshake, so there is nothing this test could pass against without either
/// (a) minting a gateway-shaped HS256 token instead of the real bearer token, which would make
/// this test pass while silently hiding that production's real wiring is broken, or (b) this
/// ticket quietly fixing a separate service's core authentication as a side effect of a test
/// suite. Both are worse than an honest skip. Unskip once the realtime-auth ticket lands; the API
/// sequence below (submit -> approve -> publish) already exercises the rest of the journey and
/// needs no changes.
///
/// Also overrides `currentStudentIdProvider` to the resolved student's real id — like
/// `ai_upsell_deep_link_test.dart`, this is the documented, test-sanctioned seam for a *separate*
/// currently-unfillable gap (no self-resolving `/students/me`), not related to why this test is
/// skipped.
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
        extraOverrides: [currentStudentIdProvider.overrideWithValue(submission.studentId)],
      );
      await app.signInWithMock(tester);

      // The student shell's Home tab already renders "Today"'s grades card off the same realtime
      // subscription `today_providers.dart` documents — no extra navigation needed.
      await approveGradeSubmission(dio, adminToken: adminToken, submissionId: submission.id);

      await pumpUntil(tester, () => find.text(label).evaluate().isNotEmpty);
      expect(find.text(label), findsOneWidget);
    },
    // Reason lives in the file-level doc comment above (testWidgets' skip is bool-only in this
    // Flutter/flutter_test version — no String-reason overload).
    skip: true,
  );
}
