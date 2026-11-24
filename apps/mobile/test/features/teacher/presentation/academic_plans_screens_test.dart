import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/domain/academic_results.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/academic_result_widgets.dart';
import 'package:studafy_mobile/src/features/teacher/application/academic_plans_providers.dart';
import 'package:studafy_mobile/src/features/teacher/application/predicted_grades_providers.dart';
import 'package:studafy_mobile/src/features/teacher/data/academic_plans_client.dart';
import 'package:studafy_mobile/src/features/teacher/data/predicted_grades_client.dart';
import 'package:studafy_mobile/src/features/teacher/domain/academic_plans.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/academic_plans_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/outcome_achievement_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/plan_reviews_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/term_plan_editor_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

const _fractions = {
  'id': 'out-1',
  'code': 'M10.1',
  'text': 'Adds fractions',
  'text_ar': 'يجمع الكسور',
  'strand': 'Number',
  'archived': false,
};

Map<String, Object?> _sheet({bool editable = true}) => {
  'section_id': 'sec-1',
  'section_name': 'A',
  'grade_level_id': 'g-10',
  'grade_level_name': 'Grade 10',
  'academic_year_id': 'year-1',
  'subject_id': 'sub-math',
  'subject_name': 'Mathematics',
  'term_id': null,
  'access': editable ? 'teacher' : 'coordinator',
  'editable': editable,
  'finalized': false,
  'show_on_report_cards': true,
  'levels': [
    {'level': 1, 'label': 'Beginning', 'label_ar': null},
    {'level': 2, 'label': 'Developing', 'label_ar': null},
    {'level': 3, 'label': 'Meeting', 'label_ar': null},
    {'level': 4, 'label': 'Exceeding', 'label_ar': null},
  ],
  'terms': [
    {'term_id': 'term-1', 'term_name': 'Term 1'},
  ],
  'outcomes': [_fractions],
  'students': [
    {
      'student_id': 'st-1',
      'first_name': 'Lina',
      'last_name': 'Haddad',
      'admission_number': 'A-1',
      'achievements': [
        {'outcome_id': 'out-1', 'level': 4},
      ],
    },
    {
      'student_id': 'st-2',
      'first_name': 'Omar',
      'last_name': 'Saleh',
      'admission_number': 'A-2',
      'achievements': <Object?>[],
    },
  ],
};

Map<String, Object?> _header({
  String id = 'plan-1',
  String status = 'submitted',
  String? comment,
  bool canEdit = false,
  bool canReview = false,
}) => {
  'id': id,
  'academic_year_id': 'year-1',
  'term_id': 'term-1',
  'term_name': 'Term 1',
  'section_id': 'sec-1',
  'section_name': 'A',
  'grade_level_id': 'g-10',
  'grade_level_name': 'Grade 10',
  'subject_id': 'sub-math',
  'subject_name': 'Mathematics',
  'author_user_id': 'user-a',
  'author_name': 'Rana Saleh',
  'status': status,
  'review_comment': comment,
  'reviewed_by_name': comment == null ? null : 'Omar Aziz',
  'due_on': '2026-09-08',
  'on_time': false,
  'can_edit': canEdit,
  'can_submit': canEdit,
  'can_delete': false,
  'can_review': canReview,
};

Map<String, Object?> _termPlan({
  String status = 'returned',
  bool canEdit = true,
  bool canReview = false,
}) => {
  ..._header(
    status: status,
    comment: status == 'returned' ? 'Add week 2' : null,
    canEdit: canEdit,
    canReview: canReview,
  ),
  'notes': 'Number first',
  'weeks': [
    {
      'week_number': 1,
      'unit': 'Fractions',
      'notes': null,
      'outcomes': [_fractions],
    },
  ],
};

class _Targets implements PredictedGradesClient {
  @override
  Future<({String sectionId, String subjectId})?> classTarget(
    String classId,
  ) async => (sectionId: 'sec-1', subjectId: 'sub-math');

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakePlans implements AcademicPlansClient {
  _FakePlans({this.termPlan, this.sheet});

  final Map<String, Object?>? termPlan;
  final Map<String, Object?>? sheet;
  final List<Map<(String, String), int?>> savedLevels = [];
  final List<String> calls = [];

  @override
  Future<SectionOutcomeAchievements> fetchAchievements(
    String sectionId,
    String subjectId, {
    required String? termId,
  }) async => SectionOutcomeAchievements.fromJson(sheet ?? _sheet());

  @override
  Future<SectionOutcomeAchievements> saveAchievements(
    String sectionId,
    String subjectId, {
    required String? termId,
    required Map<(String, String), int?> levels,
  }) async {
    savedLevels.add(levels);
    return SectionOutcomeAchievements.fromJson(sheet ?? _sheet());
  }

  @override
  Future<List<PlanSummary>> listPlans(
    PlanKind kind,
    String sectionId,
    String subjectId,
  ) async => [
    if (kind == PlanKind.lesson)
      PlanSummary.fromJson(PlanKind.lesson, {
        ..._header(id: 'lesson-1'),
        'lesson_date': '2026-10-05',
        'period': 3,
        'title': 'Adding fractions',
      }),
  ];

  @override
  Future<TermPlan> fetchTermPlan(String planId) async =>
      TermPlan.fromJson(termPlan ?? _termPlan());

  @override
  Future<LessonPlanOptions> lessonOptions(
    String sectionId,
    String subjectId, {
    required String? date,
  }) async => LessonPlanOptions.fromJson({
    'periods': [3],
    'materials': <Object?>[],
    'outcomes': [_fractions],
  });

  @override
  Future<TermPlan> saveTermPlan({
    required String sectionId,
    required String subjectId,
    required String? planId,
    required String termId,
    required String? notes,
    required List<TermPlanWeek> weeks,
  }) async {
    calls.add('save:$planId:$termId:${weeks.length}');
    return TermPlan.fromJson(termPlan ?? _termPlan());
  }

  @override
  Future<void> submit(PlanKind kind, String planId) async =>
      calls.add('submit:${kind.name}:$planId');

  @override
  Future<void> review(
    PlanKind kind,
    String planId, {
    required bool approve,
    String? comment,
  }) async => calls.add('review:$planId:$approve:$comment');

  @override
  Future<PlanReviewQueue> reviewQueue() async =>
      const PlanReviewQueue(plans: []);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<void> _pump(WidgetTester tester, _FakePlans plans, Widget home) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          academicPlansClientProvider.overrideWithValue(plans),
          predictedGradesClientProvider.overrideWithValue(_Targets()),
        ],
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

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('a teacher gives a student a level and saves only that change', (
    tester,
  ) async {
    final plans = _FakePlans();
    await _pump(
      tester,
      plans,
      const OutcomeAchievementScreen(classId: 'class-1', classCode: 'MTH-10A'),
    );

    expect(find.text('Mathematics · Grade 10 A'), findsOneWidget);
    expect(find.text('4 · Exceeding'), findsOneWidget); // Lina's saved level

    await tester.tap(find.text('No level').last); // Omar has none yet
    await tester.pumpAndSettle();
    await tester.tap(find.text('3 · Meeting').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(plans.savedLevels.single, {('st-2', 'out-1'): 3});
    expect(find.text('Achievement saved'), findsOneWidget);
  });

  testWidgets('a coordinator reads achievement without a save action', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakePlans(sheet: _sheet(editable: false)),
      const OutcomeAchievementScreen(classId: 'class-1', classCode: 'MTH-10A'),
    );
    expect(find.text('Save'), findsNothing);
    expect(
      find.text(
        'Read only: the year is closed, or you don\'t teach this class.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('the class\'s lesson plans list with their status', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakePlans(),
      const AcademicPlansScreen(classId: 'class-1', classCode: 'MTH-10A'),
    );
    expect(find.text('Adding fractions'), findsOneWidget);
    expect(find.text('Submitted'), findsOneWidget);
    expect(find.text('Late'), findsOneWidget);

    await tester.tap(find.text('Term plans'));
    await tester.pumpAndSettle();
    expect(
      find.text('No term plan yet. Tap New to start one.'),
      findsOneWidget,
    );
  });

  testWidgets('a returned term plan shows the comment and is resubmitted', (
    tester,
  ) async {
    final plans = _FakePlans();
    await _pump(
      tester,
      plans,
      const TermPlanEditorScreen(
        sectionId: 'sec-1',
        subjectId: 'sub-math',
        planId: 'plan-1',
      ),
    );

    expect(find.text('Comment from Omar Aziz'), findsOneWidget);
    expect(find.text('Add week 2'), findsOneWidget);
    expect(find.text('Returned'), findsOneWidget);

    await tester.tap(find.text('Add week'));
    await tester.pumpAndSettle();
    expect(find.text('Week 2'), findsOneWidget);
    await tester.tap(find.text('Submit'));
    await tester.pumpAndSettle();

    expect(plans.calls, ['save:plan-1:term-1:2', 'submit:term:plan-1']);
  });

  testWidgets('a coordinator returns a plan only with a comment', (
    tester,
  ) async {
    final plans = _FakePlans(
      termPlan: _termPlan(status: 'submitted', canEdit: false, canReview: true),
    );
    await _pump(
      tester,
      plans,
      const PlanReviewScreen(kind: PlanKind.term, planId: 'plan-1'),
    );

    expect(find.text('Week 1 · Fractions'), findsOneWidget);
    expect(find.text('M10.1 · Adds fractions'), findsOneWidget);

    await tester.tap(find.text('Return'));
    await tester.pumpAndSettle();
    expect(
      find.text('Say what to change before returning the plan.'),
      findsOneWidget,
    );
    expect(plans.calls, isEmpty);

    await tester.enterText(find.byType(TextField), 'Add week 2');
    await tester.tap(find.text('Return'));
    await tester.pumpAndSettle();
    expect(plans.calls, ['review:plan-1:false:Add week 2']);
  });

  testWidgets('report cards list finalized outcome achievement', (
    tester,
  ) async {
    final subject = SubjectResult.fromJson({
      'subject_id': 'sub-math',
      'subject_code': 'MTH',
      'subject_name': 'Mathematics',
      'status': 'complete',
      'max_marks': 100,
      'outcomes': [
        {
          'outcome_id': 'out-1',
          'code': 'M10.1',
          'text': 'Adds fractions',
          'text_ar': null,
          'strand': null,
          'level': 3,
          'label': 'Meeting',
          'label_ar': null,
        },
      ],
    });
    // An older server sends no outcomes at all.
    expect(
      SubjectResult.fromJson({'subject_id': 'x', 'max_marks': 1}).outcomes,
      isEmpty,
    );

    await tester.pumpWidget(
      wrapWithLocalization(
        Builder(
          builder: (context) => MaterialApp(
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: Scaffold(
              body: ReportNotesSection(report: null, subjects: [subject]),
            ),
          ),
        ),
        startLocale: AppLocales.fallback,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Learning outcomes'), findsOneWidget);
    expect(find.text('M10.1 Adds fractions: Meeting'), findsOneWidget);
  });
}
