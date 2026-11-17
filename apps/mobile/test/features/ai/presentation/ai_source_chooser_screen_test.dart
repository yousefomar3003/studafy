import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_source_providers.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_study_providers.dart';
import 'package:studafy_mobile/src/features/ai/application/ask_ai_providers.dart';
import 'package:studafy_mobile/src/features/ai/data/ai_sources_client.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_source.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_study.dart';
import 'package:studafy_mobile/src/features/ai/presentation/ai_source_chooser_screen.dart';
import 'package:studafy_mobile/src/features/ai/presentation/key_concepts_screen.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';

import '../../../support/wrap_with_localization.dart';

class _OneFileClient implements AiSourcesClient {
  @override
  Future<AiPersonalSources> list({required String studentId}) async => AiPersonalSources(
    sources: [
      AiPersonalSource(
        id: 'my-notes',
        title: 'My chemistry notes',
        fileName: 'chem.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 90000,
        status: AiSourceStatus.ready,
        hasText: true,
        createdAt: DateTime(2026, 11, 1),
      ),
    ],
    usage: AiSourceUsage.empty,
  );

  @override
  Future<List<AiAssignmentSource>> assignments({required String studentId}) async => const [];

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _NoPicker implements AiSourceFilePicker {
  @override
  Future<AiSourceFile?> pickDocument() async => null;

  @override
  Future<AiSourceFile?> pickPhoto(ImageSource source) async => null;
}

void main() {
  testWidgets('choosing one of the student\'s own photos opens key concepts on it', (tester) async {
    await tester.pumpWidget(
      wrapWithLocalization(
        ProviderScope(
          overrides: [
            aiSourcesClientProvider.overrideWithValue(_OneFileClient()),
            aiSourceFilePickerProvider.overrideWithValue(_NoPicker()),
            aiSourcePollIntervalProvider.overrideWithValue(Duration.zero),
            askAiStudentIdProvider.overrideWithValue('student-1'),
            currentEnrolledClassIdsProvider.overrideWithValue(const []),
            aiUsageProvider.overrideWith((ref) async => noAiUsage),
            keyConceptsProvider('my-notes').overrideWith(
              (ref) async => const [
                AiConcept(
                  name: 'Covalent bond',
                  explanation: 'Atoms share electron pairs.',
                  sources: [AiSourceAnchor(chunkId: 'c1', chunkIndex: 0, order: 1)],
                ),
              ],
            ),
          ],
          child: Builder(
            builder: (context) => MaterialApp(
              theme: AppTheme.light,
              debugShowCheckedModeBanner: false,
              locale: context.locale,
              supportedLocales: context.supportedLocales,
              localizationsDelegates: context.localizationDelegates,
              home: const AiSourceChooserScreen(tool: AiSourceTool.concepts),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Choose a source'), findsOneWidget);
    expect(find.text('Pick what you want the key concepts of.'), findsOneWidget);

    await tester.tap(find.text('My files & photos'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('My chemistry notes'));
    await tester.pumpAndSettle();

    expect(find.byType(KeyConceptsScreen), findsOneWidget);
    expect(find.text('Covalent bond'), findsOneWidget);
    // The student's own file is not a class material: its anchor is a label, not a link.
    expect(find.byType(ActionChip), findsNothing);
    expect(find.byType(Chip), findsOneWidget);
  });
}
