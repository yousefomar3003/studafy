import 'dart:convert';

import 'package:easy_localization/easy_localization.dart' hide TextDirection;
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:studafy_mobile/src/core/api/generated/models/material.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/material_weeks_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/material_weeks.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/material_week_sections.dart';

import '../../../../support/ensure_date_formatting.dart';
import '../../../../support/wrap_with_localization.dart';

Material _material(String id, {int? week, int? day}) => Material.fromJson({
  'id': id,
  'school_id': 'school-1',
  'class_id': 'class-1',
  'uploaded_by_user_id': 'teacher-1',
  'last_edited_by_user_id': 'teacher-1',
  'title': 'Title $id',
  'description': null,
  'storage_key': 'permanent/school-1/materials/$id.pdf',
  'original_file_name': '$id.pdf',
  'mime_type': 'application/pdf',
  'size_bytes': 1024,
  'checksum_sha256': null,
  'ai_visible': true,
  'ingest_status': 'ready',
  'ingest_error': null,
  'ingested_at': '2026-01-01T00:00:00.000Z',
  'week_number': week,
  'day_of_week': day,
  'created_at': '2026-01-01T00:00:00.000Z',
  'updated_at': '2026-01-01T00:00:00.000Z',
});

final _materials = [
  _material('w2', week: 2, day: 1),
  _material('w3-tue', week: 3, day: 2),
  _material('w3-sun', week: 3, day: 7),
  _material('legacy'),
];

/// Sunday-to-Thursday school, term from Thu 3 Sep 2026; week 3 is Sun 13 – Thu 17 Sep.
final _calendar = MaterialWeekCalendar(
  termStartsOn: DateTime(2026, 9, 3),
  termEndsOn: DateTime(2026, 12, 17),
  teachingDays: const [7, 1, 2, 3, 4],
);

Future<void> _pump(
  WidgetTester tester, {
  Locale locale = const Locale('en'),
  MaterialWeekCalendar? calendar,
}) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          materialWeekCalendarProvider(
            'class-1',
          ).overrideWith((ref) async => calendar ?? _calendar),
          // Tuesday of week 3.
          materialWeeksClockProvider.overrideWithValue(() => DateTime(2026, 9, 15, 10)),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            theme: AppTheme.light,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: Scaffold(
              body: SingleChildScrollView(
                child: MaterialWeekSections(
                  classId: 'class-1',
                  materials: _materials,
                  itemBuilder: (context, material) => Text(material.title),
                ),
              ),
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
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    resetMaterialWeekSectionsSession();
  });

  testWidgets('labels each week with its dates, the current one expanded', (tester) async {
    await _pump(tester);

    // The dates sit under the week; the current week says so too.
    expect(find.text('Week 2'), findsOneWidget);
    expect(find.text('6–10 Sep'), findsOneWidget);
    expect(find.text('Week 3'), findsOneWidget);
    expect(find.text('13–17 Sep · This week'), findsOneWidget);
    // Every week keeps its count visible while collapsed.
    expect(find.text('2 materials'), findsOneWidget);
    expect(find.text('1 material'), findsNWidgets(2));
    expect(find.text('Unscheduled'), findsOneWidget);

    // Week 3 is open, with its days in the school's order (Sunday first).
    expect(find.text('Title w3-sun'), findsOneWidget);
    expect(find.text('Title w3-tue'), findsOneWidget);
    expect(find.text('Sunday · 13 Sep'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('Sunday · 13 Sep')).dy,
      lessThan(tester.getTopLeft(find.text('Tuesday · 15 Sep')).dy),
    );
    // The others are collapsed.
    expect(find.text('Title w2'), findsNothing);
    expect(find.text('Title legacy'), findsNothing);
    // Unscheduled comes last.
    expect(
      tester.getTopLeft(find.text('Unscheduled')).dy,
      greaterThan(tester.getTopLeft(find.text('Week 3')).dy),
    );
  });

  testWidgets('tapping a header opens and closes it, and the choice is remembered', (tester) async {
    await _pump(tester);

    await tester.tap(find.text('Unscheduled'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Week 3'));
    await tester.pumpAndSettle();

    expect(find.text('Title legacy'), findsOneWidget);
    expect(find.text('Title w3-tue'), findsNothing);

    final prefs = await SharedPreferences.getInstance();
    final stored = jsonDecode(prefs.getString(materialWeekSectionsPrefsKey('class-1'))!);
    expect(stored, {'unscheduled': true, 'week-3': false});

    // A fresh screen restores it: from this run's memory, and after a restart from the device.
    await tester.pumpWidget(const SizedBox());
    await _pump(tester);
    expect(find.text('Title legacy'), findsOneWidget);
    expect(find.text('Title w3-tue'), findsNothing);

    resetMaterialWeekSectionsSession();
    await tester.pumpWidget(const SizedBox());
    await _pump(tester);
    expect(find.text('Title legacy'), findsOneWidget);
    expect(find.text('Title w3-tue'), findsNothing);
  });

  testWidgets('without term dates the weeks still group, with no dates', (tester) async {
    await _pump(tester, calendar: MaterialWeekCalendar());

    expect(find.text('Week 2'), findsOneWidget);
    expect(find.text('Week 3'), findsOneWidget);
    // No current week is known: the first section opens.
    expect(find.text('Title w2'), findsOneWidget);
    expect(find.text('Monday'), findsOneWidget);
    expect(find.text('Title w3-tue'), findsNothing);
  });

  testWidgets('renders right to left in Arabic', (tester) async {
    await _pump(tester, locale: const Locale('ar'));

    expect(find.text('غير مجدولة'), findsOneWidget);
    expect(find.textContaining('الأسبوع 3'), findsOneWidget);
    expect(find.textContaining('هذا الأسبوع'), findsOneWidget);
    final context = tester.element(find.text('غير مجدولة'));
    expect(Directionality.of(context), TextDirection.rtl);
    expect(tester.takeException(), isNull);
    // Easy Localization's own context extension resolves the same locale the sections use.
    expect(context.locale, const Locale('ar'));
  });
}
