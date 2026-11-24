import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/application/diploma_core_providers.dart';
import 'package:studafy_mobile/src/features/teacher/data/diploma_core_client.dart';
import 'package:studafy_mobile/src/features/teacher/domain/diploma_core.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/diploma_core_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

Map<String, Object?> _view({
  bool editable = true,
  bool predictedEnabled = false,
}) => {
  'section_id': 'sec-1',
  'section_name': 'A',
  'grade_level_name': 'DP2',
  'academic_year_id': 'year-1',
  'enabled': true,
  'predicted_enabled': predictedEnabled,
  'editable': editable,
  'students': [
    {
      'student_id': 'st-1',
      'first_name': 'Lina',
      'last_name': 'Haddad',
      'admission_number': 'A-1',
      'final': {
        'tok_grade': 'B',
        'ee_grade': null,
        'cas_complete': true,
        'updated_at': '2026-11-01T10:00:00.000Z',
      },
      'predicted': null,
    },
    {
      'student_id': 'st-2',
      'first_name': 'Omar',
      'last_name': 'Saleh',
      'admission_number': 'A-2',
      // A grade this build does not know reads as none, not a crash.
      'final': {
        'tok_grade': 'Z',
        'ee_grade': null,
        'cas_complete': null,
        'updated_at': '2026-11-01T10:00:00.000Z',
      },
      'predicted': null,
    },
  ],
};

class _FakeClient implements DiplomaCoreClient {
  _FakeClient(this.json);

  final Map<String, Object?> json;
  final List<(DiplomaCoreKind, Map<String, DiplomaCoreValues>)> saves = [];

  @override
  Future<SectionDiplomaCore> fetch(String sectionId) async =>
      SectionDiplomaCore.fromJson(json);

  @override
  Future<SectionDiplomaCore> save(
    String sectionId, {
    required DiplomaCoreKind kind,
    required Map<String, DiplomaCoreValues> grades,
  }) async {
    saves.add((kind, grades));
    return SectionDiplomaCore.fromJson(json);
  }
}

Future<void> _pump(
  WidgetTester tester,
  _FakeClient client, {
  Locale locale = AppLocales.fallback,
}) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [diplomaCoreClientProvider.overrideWithValue(client)],
        child: Builder(
          builder: (context) => MaterialApp(
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: const DiplomaCoreScreen(
              sectionId: 'sec-1',
              classCode: 'TOK-DP2',
            ),
          ),
        ),
      ),
      startLocale: locale,
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets(
    'a teacher sets an Extended Essay grade and saves only what changed',
    (tester) async {
      final client = _FakeClient(_view());
      await _pump(tester, client);

      expect(find.text('DP2 A'), findsOneWidget);
      expect(find.text('Lina Haddad'), findsOneWidget);
      expect(find.text('B'), findsOneWidget); // Lina's saved TOK grade

      // Lina's Extended Essay: not recorded yet.
      await tester.tap(find.text('Not recorded').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('A').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      final (kind, grades) = client.saves.single;
      expect(kind, DiplomaCoreKind.finalGrades);
      expect(grades.keys, ['st-1']);
      expect(
        grades['st-1'],
        const DiplomaCoreValues(tok: 'B', ee: 'A', casComplete: true),
      );
      expect(find.text('Core grades saved'), findsOneWidget);
    },
  );

  testWidgets(
    'predicted core grades stay read-only while predictions are off',
    (tester) async {
      await _pump(tester, _FakeClient(_view()));

      await tester.tap(find.text('Predicted'));
      await tester.pumpAndSettle();

      expect(
        find.text(
          "Your school hasn't switched predicted grades on for this grade.",
        ),
        findsOneWidget,
      );
      expect(find.widgetWithText(TextButton, 'Save'), findsNothing);
    },
  );

  testWidgets('a closed year is read-only, in Arabic too', (tester) async {
    await _pump(
      tester,
      _FakeClient(_view(editable: false)),
      locale: const Locale('ar'),
    );

    expect(
      find.text('هذا العام مغلق، لذا لا يمكن تغيير التقديرات.'),
      findsOneWidget,
    );
    expect(find.text('حفظ'), findsNothing);
  });

  test('core values parse defensively', () {
    expect(DiplomaCoreValues.fromJson(null), isNull);
    final odd = DiplomaCoreValues.fromJson({
      'tok_grade': 'Z',
      'ee_grade': 'E',
    })!;
    expect(odd.tok, isNull);
    expect(odd.ee, 'E');
    expect(const DiplomaCoreValues(tok: 'A').toJson('st-9'), {
      'student_id': 'st-9',
      'tok_grade': 'A',
      'ee_grade': null,
      'cas_complete': null,
    });
  });
}
