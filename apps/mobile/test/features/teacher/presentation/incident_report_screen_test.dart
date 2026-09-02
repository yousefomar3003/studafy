import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/create_incident_body_incident_type.dart';
import 'package:studafy_mobile/src/core/api/generated/models/create_incident_body_severity.dart';
import 'package:studafy_mobile/src/core/api/generated/models/enrollment.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/application/teacher_providers.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/incident_report_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

Widget _app({String? initialStudentId}) => Builder(
      builder: (context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        locale: context.locale,
        supportedLocales: context.supportedLocales,
        localizationsDelegates: context.localizationDelegates,
        theme: AppTheme.light,
        home: IncidentReportScreen(
          classId: 'class-1',
          classCode: 'MATH101-A',
          initialStudentId: initialStudentId,
        ),
      ),
    );

Future<void> _pump(
  WidgetTester tester, {
  required FakeStudafyApiClient api,
  List<Enrollment>? roster,
  String? initialStudentId,
}) {
  return tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          classRosterProvider('class-1').overrideWith(
            (ref) =>
                roster ?? [enrollmentFixture(studentId: 'student-abcdef')],
          ),
        ],
        child: _app(initialStudentId: initialStudentId),
      ),
    ),
  );
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('files a reported incident routed to the Principal workflow', (tester) async {
    final discipline = FakeDisciplineClient();
    await _pump(
      tester,
      api: FakeStudafyApiClient(discipline: discipline),
      initialStudentId: 'student-abcdef',
    );
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextFormField).at(0), 'Disruptive in class');
    await tester.tap(find.text('Send report'));
    await tester.pumpAndSettle();

    expect(discipline.createCalls, hasLength(1));
    final body = discipline.createCalls.single;
    expect(body.studentId, 'student-abcdef');
    expect(body.classId, 'class-1');
    expect(body.title, 'Disruptive in class');
    expect(body.incidentType, CreateIncidentBodyIncidentType.behavioral);
    expect(body.severity, CreateIncidentBodySeverity.minor);
  });

  testWidgets('requires a student before it will submit', (tester) async {
    final discipline = FakeDisciplineClient();
    await _pump(tester, api: FakeStudafyApiClient(discipline: discipline));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextFormField).at(0), 'Something happened');
    await tester.tap(find.text('Send report'));
    await tester.pumpAndSettle();

    expect(discipline.createCalls, isEmpty);
    expect(find.text('Choose the student involved.'), findsWidgets);
  });

  testWidgets('states that the report routes to the Principal', (tester) async {
    await _pump(tester, api: FakeStudafyApiClient(discipline: FakeDisciplineClient()));
    await tester.pumpAndSettle();

    expect(
      find.textContaining("Principal's discipline inbox"),
      findsOneWidget,
    );
  });
}
