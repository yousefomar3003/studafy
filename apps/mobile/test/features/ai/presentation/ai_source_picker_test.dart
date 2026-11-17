import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_source_providers.dart';
import 'package:studafy_mobile/src/features/ai/application/ask_ai_providers.dart';
import 'package:studafy_mobile/src/features/ai/data/ai_sources_client.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_source.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_source_picker.dart';

import '../../../support/wrap_with_localization.dart';

AiPersonalSource _source(
  String id,
  String title,
  AiSourceStatus status, {
  bool hasText = true,
  String mimeType = 'application/pdf',
}) => AiPersonalSource(
  id: id,
  title: title,
  fileName: '$title.pdf',
  mimeType: mimeType,
  sizeBytes: 2048,
  status: status,
  hasText: hasText,
  createdAt: DateTime(2026, 11, 1),
);

class _FakeSourcesClient implements AiSourcesClient {
  _FakeSourcesClient({
    this.sources = const [],
    this.assignmentList = const [],
    this.prepared,
    this.uploadError,
  });

  List<AiPersonalSource> sources;
  final List<AiAssignmentSource> assignmentList;
  final AiPreparedSource? prepared;
  final Object? uploadError;
  final uploads = <AiSourceFile>[];
  final deleted = <String>[];
  final preparedAssignments = <String>[];

  @override
  Future<AiPersonalSources> list({required String studentId}) async => AiPersonalSources(
    sources: sources,
    usage: AiSourceUsage(
      count: sources.length,
      bytes: 0,
      maxCount: 20,
      maxBytes: 100 * 1024 * 1024,
      maxFileBytes: 25 * 1024 * 1024,
      retentionDays: 365,
    ),
  );

  @override
  Future<AiPreparedSource> get({required String studentId, required String sourceId}) =>
      throw UnimplementedError();

  @override
  Future<void> upload({
    required String studentId,
    required AiSourceFile file,
    void Function(double progress)? onProgress,
  }) async {
    if (uploadError != null) throw uploadError!;
    uploads.add(file);
    onProgress?.call(1);
    sources = [_source('new-1', 'notes', AiSourceStatus.scanning), ...sources];
  }

  @override
  Future<void> delete({required String studentId, required String sourceId}) async {
    deleted.add(sourceId);
    sources = sources.where((source) => source.id != sourceId).toList();
  }

  @override
  Future<List<AiAssignmentSource>> assignments({required String studentId}) async => assignmentList;

  @override
  Future<AiPreparedSource> prepareAssignment({
    required String studentId,
    required String assignmentId,
  }) async {
    preparedAssignments.add(assignmentId);
    return prepared!;
  }
}

class _FakePicker implements AiSourceFilePicker {
  _FakePicker({this.file, this.error});

  final AiSourceFile? file;
  final Object? error;
  final sources = <String>[];

  @override
  Future<AiSourceFile?> pickDocument() async {
    sources.add('document');
    if (error != null) throw error!;
    return file;
  }

  @override
  Future<AiSourceFile?> pickPhoto(ImageSource source) async {
    sources.add(source.name);
    if (error != null) throw error!;
    return file;
  }
}

const _photo = (
  path: '/tmp/page.jpg',
  name: 'page.jpg',
  sizeBytes: 120000,
  contentType: 'image/jpeg',
);

Widget _harness({
  required _FakeSourcesClient client,
  _FakePicker? picker,
  Set<String> selected = const {},
  void Function(AiSourceChoice)? onSelect,
  bool multiSelect = true,
}) {
  return wrapWithLocalization(
    ProviderScope(
      overrides: [
        aiSourcesClientProvider.overrideWithValue(client),
        aiSourceFilePickerProvider.overrideWithValue(picker ?? _FakePicker()),
        askAiStudentIdProvider.overrideWithValue('student-1'),
        aiSourcePollIntervalProvider.overrideWithValue(Duration.zero),
      ],
      child: Builder(
        builder: (context) => MaterialApp(
          theme: AppTheme.light,
          debugShowCheckedModeBanner: false,
          locale: context.locale,
          supportedLocales: context.supportedLocales,
          localizationsDelegates: context.localizationDelegates,
          home: Scaffold(
            body: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                AiSourcePicker(
                  studyMaterials: const Text('class-materials-list'),
                  selected: selected,
                  multiSelect: multiSelect,
                  onSelect: onSelect ?? (_) {},
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

/// Pumps through the tab switch and the list's load. Not pumpAndSettle: a source still being
/// scanned or read shows a spinner that never settles.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i += 1) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<void> _openTab(WidgetTester tester, String label) async {
  await tester.tap(find.text(label));
  await _settle(tester);
}

void main() {
  testWidgets('offers study materials, assignments, and the student\'s own files', (tester) async {
    await tester.pumpWidget(_harness(client: _FakeSourcesClient()));
    await tester.pumpAndSettle();

    expect(find.text('Study materials'), findsOneWidget);
    expect(find.text('My assignments'), findsOneWidget);
    expect(find.text('My files & photos'), findsOneWidget);
    // The tool's own study-material list is the first tab.
    expect(find.text('class-materials-list'), findsOneWidget);

    await _openTab(tester, 'My files & photos');
    expect(find.text('class-materials-list'), findsNothing);
    expect(find.text('Upload file'), findsOneWidget);
    expect(find.text('Take photo'), findsOneWidget);
    expect(find.text('Gallery'), findsOneWidget);
    expect(find.textContaining('No files yet'), findsOneWidget);
  });

  testWidgets('lists the student\'s files with their state; only a ready one can be chosen', (
    tester,
  ) async {
    final chosen = <String>[];
    final client = _FakeSourcesClient(
      sources: [
        _source('ready-1', 'Biology notes', AiSourceStatus.ready),
        _source('busy-1', 'Chemistry page', AiSourceStatus.processing, mimeType: 'image/jpeg'),
        _source('blank-1', 'Blurry photo', AiSourceStatus.ready, hasText: false),
        _source('bad-1', 'Odd file', AiSourceStatus.blocked),
      ],
    );
    await tester.pumpWidget(_harness(client: client, onSelect: (c) => chosen.add(c.id)));
    await tester.pumpAndSettle();
    await _openTab(tester, 'My files & photos');

    expect(find.text('Biology notes'), findsOneWidget);
    expect(find.text('Ready'), findsOneWidget);
    expect(find.text('Reading the text'), findsOneWidget);
    expect(find.text('No text found'), findsOneWidget);
    expect(find.text('Blocked: unsafe file'), findsOneWidget);
    expect(find.text('4 of 20 files · kept for 12 months'), findsOneWidget);

    await tester.tap(find.text('Chemistry page'));
    await tester.tap(find.text('Blurry photo'));
    await tester.tap(find.text('Biology notes'));
    await tester.pump();
    expect(chosen, ['ready-1']);
  });

  testWidgets('takes a photo and uploads it', (tester) async {
    final client = _FakeSourcesClient();
    final picker = _FakePicker(file: _photo);
    await tester.pumpWidget(_harness(client: client, picker: picker));
    await tester.pumpAndSettle();
    await _openTab(tester, 'My files & photos');

    await tester.tap(find.byKey(const Key('aiSourceTakePhoto')));
    await _settle(tester);

    expect(picker.sources, ['camera']);
    expect(client.uploads.single.name, 'page.jpg');
    expect(client.uploads.single.contentType, 'image/jpeg');
    expect(find.text('Uploaded. It will be ready in a moment.'), findsOneWidget);
    // The list re-reads: the new upload shows, on its way through the virus check.
    expect(find.text('Checking for viruses'), findsOneWidget);
  });

  testWidgets('explains a refused upload', (tester) async {
    final refused = DioException(
      requestOptions: RequestOptions(path: '/upload'),
      error: const ApiException(
        status: 422,
        title: 'Unprocessable',
        code: 'AI_SOURCE_LIMIT_REACHED',
      ),
    );
    await tester.pumpWidget(
      _harness(
        client: _FakeSourcesClient(uploadError: refused),
        picker: _FakePicker(file: _photo),
      ),
    );
    await tester.pumpAndSettle();
    await _openTab(tester, 'My files & photos');

    await tester.tap(find.byKey(const Key('aiSourceChoosePhoto')));
    await tester.pumpAndSettle();
    expect(find.textContaining('reached the limit for your own files'), findsOneWidget);
  });

  testWidgets('a file in a format the AI tools cannot read is refused before upload', (
    tester,
  ) async {
    final client = _FakeSourcesClient();
    await tester.pumpWidget(
      _harness(
        client: client,
        picker: _FakePicker(error: const AiSourceUnsupportedFile()),
      ),
    );
    await tester.pumpAndSettle();
    await _openTab(tester, 'My files & photos');

    await tester.tap(find.byKey(const Key('aiSourceUploadFile')));
    await tester.pumpAndSettle();
    expect(client.uploads, isEmpty);
    expect(find.textContaining('Only PDF, Word, PowerPoint'), findsOneWidget);
  });

  testWidgets('deletes a file after confirming', (tester) async {
    final client = _FakeSourcesClient(
      sources: [_source('ready-1', 'Biology notes', AiSourceStatus.ready)],
    );
    await tester.pumpWidget(_harness(client: client));
    await tester.pumpAndSettle();
    await _openTab(tester, 'My files & photos');

    await tester.tap(find.byKey(const Key('aiSourceDelete-ready-1')));
    await tester.pumpAndSettle();
    expect(find.text('Delete this file?'), findsOneWidget);
    await tester.tap(find.byKey(const Key('aiSourceDeleteConfirm')));
    await tester.pumpAndSettle();

    expect(client.deleted, ['ready-1']);
    expect(find.text('Biology notes'), findsNothing);
    expect(find.text('File deleted.'), findsOneWidget);
  });

  testWidgets('uses an assignment: builds its source and chooses it once ready', (tester) async {
    final chosen = <AiSourceChoice>[];
    final client = _FakeSourcesClient(
      assignmentList: [
        AiAssignmentSource(
          assignmentId: 'assignment-1',
          title: 'Volcano report',
          classCode: 'SCI-7A',
          dueAt: DateTime(2026, 11, 20),
          attachmentCount: 2,
          aiEnabled: true,
        ),
        AiAssignmentSource(
          assignmentId: 'assignment-2',
          title: 'Poetry analysis',
          dueAt: DateTime(2026, 11, 22),
          attachmentCount: 0,
          aiEnabled: false,
        ),
      ],
      prepared: const AiPreparedSource(
        id: 'source-9',
        title: 'Volcano report',
        status: AiSourceStatus.ready,
        hasText: true,
      ),
    );
    await tester.pumpWidget(_harness(client: client, onSelect: chosen.add));
    await tester.pumpAndSettle();
    await _openTab(tester, 'My assignments');

    expect(find.text('Volcano report'), findsOneWidget);
    expect(find.textContaining('SCI-7A'), findsOneWidget);
    expect(find.textContaining('2 files'), findsOneWidget);
    // The class with the AI tools off can't be used.
    expect(find.text('AI off'), findsOneWidget);
    expect(find.text('Use'), findsOneWidget);

    await tester.tap(find.text('Use'));
    await tester.pumpAndSettle();

    expect(client.preparedAssignments, ['assignment-1']);
    expect(chosen.single.id, 'source-9');
    expect(chosen.single.kind, AiSourceKind.assignment);
  });
}
