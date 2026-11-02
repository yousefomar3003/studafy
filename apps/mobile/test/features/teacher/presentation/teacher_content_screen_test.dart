import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment.dart';
import 'package:studafy_mobile/src/core/api/generated/models/create_assignment_body.dart';
import 'package:studafy_mobile/src/core/api/generated/models/create_assignment_body_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/ingest_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/material.dart'
    as material_api;
import 'package:studafy_mobile/src/core/api/generated/models/material_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/update_assignment_body.dart';
import 'package:studafy_mobile/src/core/api/generated/models/update_assignment_body_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/update_material_body.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/teacher_content_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

const _t0 = '2026-01-01T00:00:00.000Z';

material_api.Material _materialFixture({
  required String id,
  String title = 'Notes',
  String? description,
}) => material_api.Material.fromJson({
  'id': id,
  'school_id': 'school-1',
  'class_id': 'class-1',
  'uploaded_by_user_id': 'teacher-1',
  'last_edited_by_user_id': 'teacher-1',
  'title': title,
  'description': description,
  'storage_key': 'materials/$id',
  'original_file_name': 'notes.pdf',
  'mime_type': 'application/pdf',
  'size_bytes': 1024,
  'checksum_sha256': null,
  'ai_visible': false,
  'ingest_status': 'ready',
  'ingest_error': null,
  'ingested_at': _t0,
  'created_at': _t0,
  'updated_at': _t0,
});

/// Records content writes and applies them to the class's list so the screen's refresh shows them.
class _ContentAssignmentsClient extends FakeAssignmentsClient {
  _ContentAssignmentsClient(List<Assignment> rows)
    : super(byClassId: {'class-1': rows});

  final List<CreateAssignmentBody> createCalls = [];
  final List<(String, UpdateAssignmentBody)> updateCalls = [];
  DioException? throwOnUpdate;

  @override
  Future<Assignment> createAssignment({
    required CreateAssignmentBody body,
  }) async {
    createCalls.add(body);
    final created = assignmentFixture(
      id: 'assignment-new',
      classId: body.classId,
      title: body.title,
      status: body.status.json!,
    );
    byClassId = {
      'class-1': [...byClassId['class-1']!, created],
    };
    return created;
  }

  @override
  Future<Assignment> updateAssignment({
    required String assignmentId,
    required UpdateAssignmentBody body,
  }) async {
    if (throwOnUpdate != null) throw throwOnUpdate!;
    updateCalls.add((assignmentId, body));
    final rows = byClassId['class-1']!;
    final current = rows.firstWhere((a) => a.id == assignmentId);
    final updated = Assignment.fromJson({
      ...current.toJson(),
      'title': body.title,
      'description': body.description,
      'max_score': body.maxScore,
      'status': body.status!.json,
      'attachments': <Object?>[],
    });
    byClassId = {
      'class-1': [for (final a in rows) a.id == assignmentId ? updated : a],
    };
    return updated;
  }
}

class _ContentAcademicsClient extends FakeAcademicsClient {
  _ContentAcademicsClient(this.materials);

  List<material_api.Material> materials;
  final List<(String, UpdateMaterialBody)> updateCalls = [];

  @override
  Future<MaterialList> listMaterials({
    String? classId,
    IngestStatus? ingestStatus,
    int? limit = 20,
    int? offset = 0,
  }) async => MaterialList(materials: materials, total: materials.length);

  @override
  Future<material_api.Material> updateMaterial({
    required String materialId,
    required UpdateMaterialBody body,
  }) async {
    updateCalls.add((materialId, body));
    materials = [
      for (final m in materials)
        m.id == materialId
            ? material_api.Material.fromJson({
                ...m.toJson(),
                'title': body.title,
                'description': body.description,
              })
            : m,
    ];
    return materials.firstWhere((m) => m.id == materialId);
  }
}

Future<void> _pump(WidgetTester tester, FakeStudafyApiClient api) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [apiClientProvider.overrideWithValue(api)],
        child: Builder(
          builder: (context) => MaterialApp(
            debugShowCheckedModeBanner: false,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: const TeacherContentScreen(
              classId: 'class-1',
              classCode: 'MATH101-A',
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _tapVisible(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets(
    'edits an assignment with the form prefilled and refreshes the list',
    (tester) async {
      final assignments = _ContentAssignmentsClient([
        assignmentFixture(id: 'a-1', classId: 'class-1', title: 'Worksheet'),
      ]);
      await _pump(
        tester,
        FakeStudafyApiClient(
          assignments: assignments,
          academics: _ContentAcademicsClient([]),
        ),
      );

      await tester.tap(find.byTooltip('Edit assignment'));
      await tester.pumpAndSettle();

      expect(find.text('Edit assignment'), findsOneWidget);
      expect(find.widgetWithText(TextFormField, 'Worksheet'), findsOneWidget);
      expect(find.widgetWithText(TextFormField, '100'), findsOneWidget);

      await tester.enterText(find.byType(TextFormField).at(0), 'Worksheet v2');
      await tester.enterText(find.byType(TextFormField).at(2), '50');
      await _tapVisible(tester, find.text('Save changes'));
      await tester.pumpAndSettle();

      expect(assignments.updateCalls, hasLength(1));
      final (id, body) = assignments.updateCalls.single;
      expect(id, 'a-1');
      expect(body.title, 'Worksheet v2');
      expect(body.maxScore, 50);
      expect(body.description, isNull);
      expect(body.allowLateSubmission, isTrue);
      expect(body.status, UpdateAssignmentBodyStatus.published);
      expect(body.dueAt, DateTime.parse(_t0));
      // Back on the list, showing the refreshed row.
      expect(find.text('Worksheet v2'), findsOneWidget);
    },
  );

  testWidgets(
    'a published assignment cannot be moved back to draft from the form',
    (tester) async {
      await _pump(
        tester,
        FakeStudafyApiClient(
          assignments: _ContentAssignmentsClient([
            assignmentFixture(id: 'a-1', classId: 'class-1'),
          ]),
          academics: _ContentAcademicsClient([]),
        ),
      );

      await tester.tap(find.text('Worksheet'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Published'));
      await tester.pumpAndSettle();

      expect(find.text('Closed'), findsOneWidget);
      expect(find.text('Draft'), findsNothing);
    },
  );

  testWidgets('shows the status-transition rejection from the API', (
    tester,
  ) async {
    final assignments =
        _ContentAssignmentsClient([
            assignmentFixture(id: 'a-1', classId: 'class-1'),
          ])
          ..throwOnUpdate = DioException(
            requestOptions: RequestOptions(
              path: '/api/academics/assignments/a-1',
            ),
            error: const ApiException(
              status: 409,
              title: 'Conflict',
              code: 'ASSIGNMENT_INVALID_STATUS_TRANSITION',
            ),
          );
    await _pump(
      tester,
      FakeStudafyApiClient(
        assignments: assignments,
        academics: _ContentAcademicsClient([]),
      ),
    );

    await tester.tap(find.byTooltip('Edit assignment'));
    await tester.pumpAndSettle();
    await _tapVisible(tester, find.text('Save changes'));
    await tester.pumpAndSettle();

    expect(
      find.text("A published assignment can't go back to draft."),
      findsOneWidget,
    );
    // Still on the form so the teacher can correct and retry.
    expect(find.text('Edit assignment'), findsOneWidget);
  });

  testWidgets('creates an assignment as a draft', (tester) async {
    final assignments = _ContentAssignmentsClient([]);
    await _pump(
      tester,
      FakeStudafyApiClient(
        assignments: assignments,
        academics: _ContentAcademicsClient([]),
      ),
    );

    await tester.tap(find.text('Create assignment'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).at(0), 'Essay');
    await _tapVisible(tester, find.text('Published'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Draft').last);
    await tester.pumpAndSettle();
    await _tapVisible(tester, find.text('Save as draft'));
    await tester.pumpAndSettle();

    expect(assignments.createCalls, hasLength(1));
    expect(assignments.createCalls.single.title, 'Essay');
    expect(
      assignments.createCalls.single.status,
      CreateAssignmentBodyStatus.draft,
    );
    expect(find.text('Essay'), findsOneWidget);
  });

  testWidgets('edits a material title and description', (tester) async {
    final academics = _ContentAcademicsClient([
      _materialFixture(id: 'm-1', title: 'Notes', description: 'Old'),
    ]);
    await _pump(
      tester,
      FakeStudafyApiClient(
        assignments: _ContentAssignmentsClient([]),
        academics: academics,
      ),
    );

    await tester.tap(find.text('Materials'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Edit material'));
    await tester.pumpAndSettle();

    expect(find.widgetWithText(TextFormField, 'Notes'), findsOneWidget);
    await tester.enterText(find.byType(TextFormField).at(0), 'Chapter 1 notes');
    await tester.enterText(find.byType(TextFormField).at(1), '');
    await _tapVisible(tester, find.text('Save changes'));
    await tester.pumpAndSettle();

    expect(academics.updateCalls, hasLength(1));
    final (id, body) = academics.updateCalls.single;
    expect(id, 'm-1');
    expect(body.title, 'Chapter 1 notes');
    expect(body.description, isNull);
    expect(find.text('Chapter 1 notes'), findsOneWidget);
  });

  testWidgets('blocks saving a material with an empty title', (tester) async {
    final academics = _ContentAcademicsClient([_materialFixture(id: 'm-1')]);
    await _pump(
      tester,
      FakeStudafyApiClient(
        assignments: _ContentAssignmentsClient([]),
        academics: academics,
      ),
    );

    await tester.tap(find.text('Materials'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Edit material'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).at(0), '  ');
    await _tapVisible(tester, find.text('Save changes'));
    await tester.pumpAndSettle();

    expect(academics.updateCalls, isEmpty);
    expect(find.text('Enter a title.'), findsOneWidget);
  });
}
