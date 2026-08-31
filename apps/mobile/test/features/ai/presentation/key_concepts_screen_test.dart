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
import 'package:studafy_mobile/src/features/ai/domain/ai_study.dart';
import 'package:studafy_mobile/src/features/ai/presentation/key_concepts_screen.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_source_anchor_chip.dart';

import '../../../support/wrap_with_localization.dart';

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

Widget _screen({
  required Future<List<AiConcept>> Function() concepts,
  String? studentId = 'student-1',
}) {
  return wrapWithLocalization(
    ProviderScope(
      overrides: [
        askAiStudentIdProvider.overrideWithValue(studentId),
        aiUsageProvider.overrideWith(
          (ref) async => const AiUsage(
            active: false,
            budget: 0,
            usedTokens: 0,
            heldTokens: 0,
            remaining: 0,
          ),
        ),
        keyConceptsProvider('material-1').overrideWith((ref) => concepts()),
      ],
      child: Builder(
        builder: (context) => MaterialApp(
          theme: AppTheme.light,
          debugShowCheckedModeBanner: false,
          locale: context.locale,
          supportedLocales: context.supportedLocales,
          localizationsDelegates: context.localizationDelegates,
          home: KeyConceptsScreen(material: _material()),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('renders a card and source anchors per concept', (tester) async {
    await tester.pumpWidget(
      _screen(
        concepts: () async => const [
          AiConcept(
            name: 'Osmosis',
            explanation: 'Water moves across a membrane down its potential gradient.',
            sources: [
              AiSourceAnchor(
                chunkId: 'c1',
                chunkIndex: 0,
                order: 1,
                pageNumber: 4,
                sectionTitle: 'Transport',
              ),
            ],
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Osmosis'), findsOneWidget);
    expect(
      find.text('Water moves across a membrane down its potential gradient.'),
      findsOneWidget,
    );
    expect(find.byType(AiSourceAnchorChip), findsOneWidget);
  });

  testWidgets('renders the empty state when no concepts are found', (tester) async {
    await tester.pumpWidget(_screen(concepts: () async => const <AiConcept>[]));
    await tester.pumpAndSettle();

    expect(find.text('No key concepts were found in this material.'), findsOneWidget);
  });

  testWidgets('renders the error card on failure', (tester) async {
    await tester.pumpWidget(
      _screen(
        concepts: () async => throw const ApiException(
          status: 422,
          title: 'not ready',
          code: 'VALIDATION_FAILED',
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.text('This material is still being processed. Check back soon.'),
      findsOneWidget,
    );
  });
}
