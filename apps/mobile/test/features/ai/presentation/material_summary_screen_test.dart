import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/core/api/generated/models/material.dart';
import 'package:studafy_mobile/src/core/api/generated/models/material_ingest_status.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_study_providers.dart';
import 'package:studafy_mobile/src/features/ai/application/ask_ai_providers.dart';
import 'package:studafy_mobile/src/features/ai/data/ai_study_client.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_study.dart';
import 'package:studafy_mobile/src/features/ai/presentation/material_summary_screen.dart';

import '../../../support/wrap_with_localization.dart';

class _FakeAiStudyClient implements AiStudyClient {
  _FakeAiStudyClient({this.summarizeHandler});

  Future<AiSummary> Function(AiSummaryLength length)? summarizeHandler;

  @override
  Future<AiSummary> summarize({
    required String studentId,
    required String materialId,
    required AiSummaryLength length,
  }) async {
    final handler = summarizeHandler;
    if (handler != null) return handler(length);
    return AiSummary(
      text: 'This is the ${length.name} summary.',
      length: length,
      cached: false,
      sources: const [],
    );
  }

  @override
  Future<List<AiConcept>> concepts({
    required String studentId,
    required String materialId,
  }) async => const [];

  @override
  Future<AiUsage> usage() async =>
      const AiUsage(active: true, budget: 1000, usedTokens: 250, heldTokens: 0, remaining: 750);
}

Material _material() => Material(
  id: 'material-1',
  schoolId: 'school-1',
  classId: 'class-1',
  uploadedByUserId: 'u1',
  lastEditedByUserId: 'u1',
  title: 'Cell Biology',
  description: null,
  storageKey: 'k',
  originalFileName: 'cell.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  checksumSha256: null,
  aiVisible: true,
  ingestStatus: MaterialIngestStatus.ready,
  ingestError: null,
  ingestedAt: null,
  createdAt: DateTime(2026, 1, 1),
  updatedAt: DateTime(2026, 1, 1),
);

Widget _screen({required AiStudyClient client, String? studentId = 'student-1'}) {
  return wrapWithLocalization(
    ProviderScope(
      overrides: [
        aiStudyClientProvider.overrideWithValue(client),
        askAiStudentIdProvider.overrideWithValue(studentId),
        aiUsageProvider.overrideWith(
          (ref) async => const AiUsage(
            active: true,
            budget: 1000,
            usedTokens: 250,
            heldTokens: 0,
            remaining: 750,
          ),
        ),
      ],
      child: Builder(
        builder: (context) => MaterialApp(
          theme: AppTheme.light,
          debugShowCheckedModeBanner: false,
          locale: context.locale,
          supportedLocales: context.supportedLocales,
          localizationsDelegates: context.localizationDelegates,
          home: MaterialSummaryScreen(material: _material()),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('renders the standard summary and the quota meter', (tester) async {
    await tester.pumpWidget(_screen(client: _FakeAiStudyClient()));
    await tester.pumpAndSettle();

    expect(find.text('This is the standard summary.'), findsOneWidget);
    expect(find.textContaining('AI tokens used this month'), findsOneWidget);
  });

  testWidgets('switching the length preset re-renders the summary', (tester) async {
    await tester.pumpWidget(_screen(client: _FakeAiStudyClient()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Detailed'));
    await tester.pumpAndSettle();
    expect(find.text('This is the detailed summary.'), findsOneWidget);

    // Back to a preset already fetched — served from the controller's cache.
    await tester.tap(find.text('Standard'));
    await tester.pumpAndSettle();
    expect(find.text('This is the standard summary.'), findsOneWidget);
  });

  testWidgets('shows the "from cache" badge on a server-cached summary', (tester) async {
    final client = _FakeAiStudyClient(
      summarizeHandler: (length) async =>
          AiSummary(text: 'cached body', length: length, cached: true, sources: const []),
    );
    await tester.pumpWidget(_screen(client: client));
    await tester.pumpAndSettle();

    expect(find.text('From cache'), findsOneWidget);
  });

  testWidgets('renders the error card when the summary fails', (tester) async {
    final client = _FakeAiStudyClient(
      summarizeHandler: (_) => throw const ApiException(
        status: 503,
        title: 'off',
        code: 'AI_LLM_DISABLED',
      ),
    );
    await tester.pumpWidget(_screen(client: client));
    await tester.pumpAndSettle();

    expect(find.text('The AI assistant is currently switched off.'), findsOneWidget);
  });

  testWidgets('shows the signed-out view with no session', (tester) async {
    await tester.pumpWidget(_screen(client: _FakeAiStudyClient(), studentId: null));
    await tester.pumpAndSettle();

    expect(find.text('Sign in to use the AI study tools.'), findsOneWidget);
    expect(find.byType(SegmentedButton<AiSummaryLength>), findsNothing);
  });
}
