import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/application/grade_entry_providers.dart';
import 'package:studafy_mobile/src/features/teacher/data/grade_entry_client.dart';
import 'package:studafy_mobile/src/features/teacher/domain/grade_entry.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/grade_entry_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/widgets/grade_entry_row.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/widgets/grade_status_chip.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

const _t0 = '2026-01-01T00:00:00.000Z';

Map<String, Object?> _cell(String id, String label, {num? score, num maxScore = 100}) => {
      'id': id,
      'grade_submission_id': 'sub-$id',
      'label': label,
      'score': score,
      'max_score': maxScore,
      'weight': 1,
      'created_at': _t0,
      'updated_at': _t0,
    };

GradeSubmission _submission(
  String id,
  String studentId, {
  String status = 'draft',
  List<Map<String, Object?>> cells = const [],
}) =>
    GradeSubmission.fromJson({
      'id': id,
      'gradebook_id': 'gb-1',
      'student_id': studentId,
      'status': status,
      'rejection_reason': null,
      'submitted_by_user_id': null,
      'decided_by_user_id': null,
      'submitted_at': null,
      'decided_at': null,
      'created_at': _t0,
      'updated_at': _t0,
      'grades': cells,
    });

class _FakeGradeEntryClient implements GradeEntryClient {
  int bulkCalls = 0;

  @override
  Future<List<GradeCell>> bulkUpdateGrades(String gradebookId, List<GradeScoreEdit> edits) async {
    bulkCalls++;
    return const [];
  }

  @override
  Future<List<GradeSubmission>> createAssessment(String gradebookId,
          {required String label, required double maxScore, double weight = 1}) async =>
      const [];

  @override
  Future<List<GradeSubmission>> fetchEntry(String gradebookId) async => const [];

  @override
  Future<GradebookRef> resolveGradebook(String classId) => throw UnimplementedError();

  @override
  Future<GradeSubmission> submitSubmission(String gradebookId, String submissionId,
          {required String updatedAt}) =>
      throw UnimplementedError();
}

GradebookRef _gradebook() => const GradebookRef(
      id: 'gb-1',
      classId: 'class-1',
      status: 'draft',
      gradingSchemeId: null,
    );

Widget _screenApp() => Builder(
      builder: (context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        locale: context.locale,
        supportedLocales: context.supportedLocales,
        localizationsDelegates: context.localizationDelegates,
        theme: AppTheme.light,
        home: const GradeEntryScreen(classId: 'class-1', classCode: 'MATH101-A'),
      ),
    );

Future<void> _pump(
  WidgetTester tester, {
  required GradeEntryGrid grid,
  _FakeGradeEntryClient? client,
}) {
  return tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          gradeEntryClientProvider.overrideWithValue(client ?? _FakeGradeEntryClient()),
          gradebookForClassProvider('class-1').overrideWith((ref) async => _gradebook()),
          gradeEntryGridProvider('gb-1').overrideWith((ref) async => grid),
        ],
        child: _screenApp(),
      ),
    ),
  );
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('a submitted student shows a status chip instead of an editable score', (tester) async {
    await _pump(
      tester,
      grid: GradeEntryGrid([
        _submission('s1', 'stu-aaaaaa', cells: [_cell('g1', 'Midterm', score: 40)]),
        _submission('s2', 'stu-bbbbbb',
            status: 'submitted', cells: [_cell('g2', 'Midterm', score: 88)]),
      ]),
    );
    await tester.pumpAndSettle();

    // Assessment list → open "Midterm".
    await tester.tap(find.text('Midterm'));
    await tester.pumpAndSettle();

    expect(find.byType(GradeEntryRow), findsNWidgets(2));
    expect(find.byType(GradeStatusChip), findsOneWidget);
    expect(find.text('Awaiting approval'), findsOneWidget);
  });

  testWidgets('a score above the assessment maximum is flagged inline and not saved',
      (tester) async {
    final client = _FakeGradeEntryClient();
    await _pump(
      tester,
      client: client,
      grid: GradeEntryGrid([
        _submission('s1', 'stu-aaaaaa', cells: [_cell('g1', 'Quiz', maxScore: 50)]),
      ]),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Quiz'));
    await tester.pumpAndSettle();

    // Focus the only row, then enter 75 on the docked keypad.
    await tester.tap(find.byType(GradeEntryRow).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('7'));
    await tester.pump();
    await tester.tap(find.text('5'));
    await tester.pump();

    expect(find.textContaining('Above the maximum'), findsOneWidget);

    // Let any debounce elapse — the out-of-range value must never reach the API.
    await tester.pump(const Duration(seconds: 2));
    expect(client.bulkCalls, 0);
  });
}
