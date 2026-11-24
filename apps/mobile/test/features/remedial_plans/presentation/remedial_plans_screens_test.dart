import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/remedial_plans/application/remedial_plans_providers.dart';
import 'package:studafy_mobile/src/features/remedial_plans/data/remedial_plans_client.dart';
import 'package:studafy_mobile/src/features/remedial_plans/domain/remedial_plan.dart';
import 'package:studafy_mobile/src/features/remedial_plans/presentation/remedial_plan_detail_screen.dart';
import 'package:studafy_mobile/src/features/remedial_plans/presentation/section_remedial_plans_screen.dart';
import 'package:studafy_mobile/src/features/remedial_plans/presentation/widgets/remedial_plans_section.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

Map<String, Object?> _summary({
  String status = 'open',
  bool overdue = true,
  bool shared = false,
}) => {
  'id': 'plan-1',
  'academic_year_id': 'year-1',
  'term_id': null,
  'term_name': null,
  'section_id': 'sec-1',
  'section_name': 'A',
  'grade_level_id': 'g-10',
  'grade_level_name': 'Grade 10',
  'student_id': 'st-1',
  'student_first_name': 'Lina',
  'student_last_name': 'Haddad',
  'admission_number': 'A-1',
  'subject_id': 'sub-math',
  'subject_name': 'Mathematics',
  'reason': 'below_pass',
  'status': status,
  'shared_with_family': shared,
  'next_review_on': '2026-11-20',
  'overdue': overdue,
  'last_note_at': null,
  'created_by_name': 'Omar Aziz',
  'created_at': '2026-11-01T08:00:00.000Z',
  'updated_at': '2026-11-01T08:00:00.000Z',
};

Map<String, Object?> _plan({
  String access = 'teacher',
  bool canEdit = true,
  bool canAddNote = true,
  bool withInternal = true,
}) => {
  ..._summary(),
  'reason_note': 'Struggles with algebra',
  'targets': 'Solve linear equations',
  'actions': 'Weekly practice sheet',
  'start_percentage': 38,
  'pass_percentage': 50,
  'reviews': [
    {'review_on': '2026-11-20', 'completed_at': null, 'overdue': true},
  ],
  'notes': [
    {
      'id': 'n-1',
      'kind': 'status_change',
      'body': 'Sessions started',
      'new_status': 'in_progress',
      'internal': false,
      'author_name': 'Omar Aziz',
      'author_access': 'teacher',
      'created_at': '2026-11-02T08:00:00.000Z',
    },
    if (withInternal)
      {
        'id': 'n-2',
        'kind': 'note',
        'body': 'Parents not told yet',
        'new_status': null,
        'internal': true,
        'author_name': 'Huda Coordinator',
        'author_access': 'coordinator',
        'created_at': '2026-11-03T08:00:00.000Z',
      },
  ],
  'access': access,
  'can_edit': canEdit,
  'can_add_note': canAddNote,
  'family_sharing_enabled': true,
};

Map<String, Object?> _section({
  String access = 'teacher',
  bool canCreate = true,
  List<Map<String, Object?>> plans = const [],
}) => {
  'section_id': 'sec-1',
  'section_name': 'A',
  'grade_level_name': 'Grade 10',
  'academic_year_id': 'year-1',
  'subject_id': 'sub-math',
  'subject_name': 'Mathematics',
  'term_id': null,
  'terms': [
    {'term_id': 'term-1', 'term_name': 'Term 1'},
  ],
  'access': access,
  'can_create': canCreate,
  'family_sharing_enabled': true,
  'pass_percentage': 50,
  'students': [
    {
      'student_id': 'st-1',
      'first_name': 'Lina',
      'last_name': 'Haddad',
      'admission_number': 'A-1',
    },
    {
      'student_id': 'st-2',
      'first_name': 'Omar',
      'last_name': 'Saleh',
      'admission_number': 'A-2',
    },
  ],
  'suggestions': [
    {
      'student_id': 'st-1',
      'first_name': 'Lina',
      'last_name': 'Haddad',
      'admission_number': 'A-1',
      'percentage': 38.5,
      'provisional': true,
      'active_plan_id': null,
    },
  ],
  'plans': plans,
};

class _FakeClient implements RemedialPlansClient {
  _FakeClient({
    Map<String, Object?>? section,
    Map<String, Object?>? plan,
    this.studentPlans = const [],
  }) : section = section ?? _section(),
       plan = plan ?? _plan();

  final Map<String, Object?> section;
  final Map<String, Object?> plan;
  final List<Map<String, Object?>> studentPlans;
  final List<String?> fetchedTerms = [];
  final List<Map<String, Object?>> created = [];
  final List<(String, bool)> notes = [];

  @override
  Future<SectionRemedialPlans> fetchSection(
    String sectionId,
    String subjectId, {
    required String? termId,
  }) async {
    fetchedTerms.add(termId);
    return SectionRemedialPlans.fromJson(section);
  }

  @override
  Future<RemedialPlan> fetchPlan(String planId) async =>
      RemedialPlan.fromJson(plan);

  @override
  Future<List<RemedialPlan>> fetchStudent(String studentId) async => [
    for (final json in studentPlans) RemedialPlan.fromJson(json),
  ];

  @override
  Future<RemedialPlan> create({
    required String sectionId,
    required String subjectId,
    required String studentId,
    required String? termId,
    required RemedialPlanReason reason,
    required String? reasonNote,
    required String targets,
    required String actions,
    required List<DateTime> reviewDates,
    required bool sharedWithFamily,
  }) async {
    created.add({
      'student_id': studentId,
      'term_id': termId,
      'reason': reason.wire,
      'targets': targets,
      'actions': actions,
      'shared_with_family': sharedWithFamily,
    });
    return RemedialPlan.fromJson(plan);
  }

  @override
  Future<RemedialPlan> update(
    String planId, {
    RemedialPlanReason? reason,
    String? reasonNote,
    String? targets,
    String? actions,
    List<DateTime>? reviewDates,
    RemedialPlanStatus? status,
    String? statusNote,
    bool? sharedWithFamily,
  }) async => RemedialPlan.fromJson(plan);

  @override
  Future<RemedialPlan> addNote(
    String planId, {
    required String body,
    required bool internal,
  }) async {
    notes.add((body, internal));
    return RemedialPlan.fromJson(plan);
  }
}

Future<void> _pump(WidgetTester tester, _FakeClient client, Widget home) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [remedialPlansClientProvider.overrideWithValue(client)],
        child: Builder(
          builder: (context) => MaterialApp(
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: home,
          ),
        ),
      ),
      startLocale: AppLocales.fallback,
    ),
  );
  await tester.pumpAndSettle();
}

const _sectionScreen = SectionRemedialPlansScreen(
  sectionId: 'sec-1',
  subjectId: 'sub-math',
  title: 'MATH-10A',
);

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('a teacher sees the suggested students and opens a plan', (
    tester,
  ) async {
    final client = _FakeClient();
    await _pump(tester, client, _sectionScreen);

    expect(find.text('Mathematics · Grade 10 A'), findsOneWidget);
    expect(
      find.text('Current mark 38.5% (some marks missing)'),
      findsOneWidget,
    );
    expect(find.text('No remedial plans yet.'), findsOneWidget);

    await tester.tap(find.text('Open plan'));
    await tester.pumpAndSettle();
    // The suggested student is preselected, with "below the pass line" as the reason.
    expect(find.text('Lina Haddad'), findsOneWidget);
    expect(find.text('Below the pass line'), findsOneWidget);

    await tester.enterText(
      find.widgetWithText(TextFormField, 'Target skills or outcomes'),
      'Solve linear equations',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Actions'),
      'Weekly practice sheet',
    );
    await tester.tap(find.text('Share with the student and parents'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(client.created.single, {
      'student_id': 'st-1',
      'term_id': null,
      'reason': 'below_pass',
      'targets': 'Solve linear equations',
      'actions': 'Weekly practice sheet',
      'shared_with_family': true,
    });
    // Saving opens the new plan.
    expect(find.text('Solve linear equations'), findsOneWidget);
  });

  testWidgets('targets and actions are required', (tester) async {
    final client = _FakeClient();
    await _pump(tester, client, _sectionScreen);
    await tester.tap(find.text('New plan'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(
      find.text('Required'),
      findsNWidgets(3),
    ); // student, targets, actions
    expect(client.created, isEmpty);
  });

  testWidgets('choosing a term reloads the suggestions for it', (tester) async {
    final client = _FakeClient();
    await _pump(tester, client, _sectionScreen);
    await tester.tap(find.text('Whole year'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Term 1').last);
    await tester.pumpAndSettle();
    expect(client.fetchedTerms, [null, 'term-1']);
  });

  testWidgets('a coordinator follows up: no new plans, plans listed', (
    tester,
  ) async {
    final client = _FakeClient(
      section: _section(
        access: 'coordinator',
        canCreate: false,
        plans: [_summary()],
      ),
    );
    await _pump(tester, client, _sectionScreen);
    expect(find.text('New plan'), findsNothing);
    expect(find.text('Open plan'), findsNothing);
    expect(find.text('Review overdue'), findsOneWidget);
    expect(find.text('Lina Haddad'), findsWidgets);
  });

  testWidgets('a coordinator adds a staff-only note but cannot edit', (
    tester,
  ) async {
    final client = _FakeClient(
      plan: _plan(access: 'coordinator', canEdit: false),
    );
    await _pump(tester, client, const RemedialPlanDetailScreen(planId: 'p'));

    expect(find.byTooltip('Edit plan'), findsNothing);
    expect(find.text('Solve linear equations'), findsOneWidget);
    expect(find.text('Parents not told yet'), findsOneWidget);

    await tester.tap(find.text('Add note'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'Checked in');
    await tester.tap(find.byType(Switch).last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save note'));
    await tester.pumpAndSettle();
    expect(client.notes.single, ('Checked in', true));
  });

  testWidgets('a parent reads a shared plan without any staff actions', (
    tester,
  ) async {
    final client = _FakeClient(
      plan: _plan(
        access: 'family',
        canEdit: false,
        canAddNote: false,
        withInternal: false,
      ),
    );
    await _pump(tester, client, const RemedialPlanDetailScreen(planId: 'p'));

    expect(find.text('Weekly practice sheet'), findsOneWidget);
    expect(find.text('Sessions started'), findsOneWidget);
    expect(find.byTooltip('Edit plan'), findsNothing);
    expect(find.text('Add note'), findsNothing);
    expect(find.text('Staff only'), findsNothing);
  });

  testWidgets('the results section shows only when a plan is shared', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeClient(),
      const Scaffold(body: RemedialPlansSection(studentId: 'st-1')),
    );
    expect(find.text('Support plans'), findsNothing);

    await _pump(
      tester,
      _FakeClient(
        studentPlans: [
          _plan(access: 'family', canEdit: false, withInternal: false),
        ],
      ),
      const Scaffold(body: RemedialPlansSection(studentId: 'st-1')),
    );
    expect(find.text('Support plans'), findsOneWidget);
    expect(find.text('Mathematics'), findsOneWidget);
  });

  test('parsing tolerates missing fields and unknown values', () {
    final plan = RemedialPlan.fromJson({
      'status': 'paused',
      'reason': 'something_new',
      'access': 'robot',
      'reviews': [
        {'review_on': 'bad'},
        {'review_on': '2026-12-01'},
      ],
      'notes': ['garbage'],
    });
    expect(plan.summary.status, RemedialPlanStatus.unknown);
    expect(plan.summary.status.next, isEmpty);
    expect(plan.summary.reason, RemedialPlanReason.unknown);
    expect(plan.access, RemedialPlanAccess.family);
    expect(plan.canEdit, isFalse);
    expect(plan.reviews.single.reviewOn, DateTime(2026, 12));
    expect(plan.notes, isEmpty);
    expect(remedialWireDate(DateTime(2026, 3, 7)), '2026-03-07');
  });
}
