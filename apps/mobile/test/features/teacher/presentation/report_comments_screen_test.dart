import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/application/report_comments_providers.dart';
import 'package:studafy_mobile/src/features/teacher/data/report_comments_client.dart';
import 'package:studafy_mobile/src/features/teacher/domain/report_comments.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/report_comments_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

Map<String, Object?> _notes({
  bool finalized = false,
  bool canComment = true,
}) => {
  'section_id': 'sec-1',
  'term_id': null,
  'finalized': finalized,
  'editable': !finalized,
  'can_edit_class_notes': !finalized,
  'can_edit_principal_comment': false,
  'settings': {'show_subject_comments': true},
  'subjects': [
    {
      'subject_id': 'sub-math',
      'subject_name': 'Mathematics',
      'can_comment': canComment,
    },
    {'subject_id': 'sub-sci', 'subject_name': 'Science', 'can_comment': false},
  ],
  'students': [
    {
      'student_id': 'st-1',
      'first_name': 'Lina',
      'last_name': 'Haddad',
      'admission_number': 'A-1',
      'teacher_comment': null,
      'principal_comment': null,
      'conduct_code': null,
      'subject_comments': [
        {'subject_id': 'sub-math', 'body': 'Strong problem solver.'},
        {'subject_id': 'sub-sci', 'body': 'Curious in the lab.'},
      ],
    },
    {
      'student_id': 'st-2',
      'first_name': 'Omar',
      'last_name': 'Saleh',
      'admission_number': 'A-2',
      'teacher_comment': null,
      'principal_comment': null,
      'conduct_code': null,
      'subject_comments': <Object?>[],
    },
  ],
};

class _FakeClient implements ReportCommentsClient {
  _FakeClient(this.json);

  Map<String, Object?> json;
  final List<Map<String, String>> saves = [];

  @override
  Future<SubjectReportComments> fetch(
    String sectionId,
    String subjectId, {
    required String? termId,
  }) async => SubjectReportComments.fromJson(json, subjectId);

  @override
  Future<SubjectReportComments> save(
    String sectionId,
    String subjectId, {
    required String? termId,
    required Map<String, String> comments,
  }) async {
    saves.add(comments);
    return SubjectReportComments.fromJson(json, subjectId);
  }
}

Future<void> _pump(WidgetTester tester, _FakeClient client) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [reportCommentsClientProvider.overrideWithValue(client)],
        child: Builder(
          builder: (context) => MaterialApp(
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: const ReportCommentsScreen(
              sectionId: 'sec-1',
              subjectId: 'sub-math',
              termId: null,
              subjectName: 'Mathematics',
              periodName: 'Annual',
            ),
          ),
        ),
      ),
      startLocale: AppLocales.fallback,
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('shows only this subject\'s comments and saves what changed', (
    tester,
  ) async {
    final client = _FakeClient(_notes());
    await _pump(tester, client);

    expect(find.text('Strong problem solver.'), findsOneWidget);
    expect(find.text('Curious in the lab.'), findsNothing);

    await tester.enterText(
      find.widgetWithText(TextField, 'Omar Saleh'),
      'Needs to show working.',
    );
    await tester.pump();
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(client.saves, [
      {'st-2': 'Needs to show working.'},
    ]);
    expect(find.text('Comments saved'), findsOneWidget);
  });

  testWidgets('a finalized period is read-only', (tester) async {
    await _pump(
      tester,
      _FakeClient(_notes(finalized: true, canComment: false)),
    );

    expect(
      find.text(
        'These results are finalized, so the comments can no longer change.',
      ),
      findsOneWidget,
    );
    expect(find.text('Save'), findsNothing);
    final field = tester.widget<TextField>(
      find.widgetWithText(TextField, 'Lina Haddad'),
    );
    expect(field.enabled, isFalse);
  });
}
