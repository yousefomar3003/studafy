import 'dart:typed_data';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/ai/application/ask_ai_controller.dart';
import 'package:studafy_mobile/src/features/ai/application/ask_ai_providers.dart';
import 'package:studafy_mobile/src/features/ai/data/ai_photo_text_client.dart';
import 'package:studafy_mobile/src/features/ai/data/ask_ai_client.dart';
import 'package:studafy_mobile/src/features/ai/data/ask_ai_events.dart';
import 'package:studafy_mobile/src/features/ai/domain/ask_ai_conversation.dart';
import 'package:studafy_mobile/src/features/ai/presentation/ask_ai_screen.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ask_ai_citation_chip.dart';

import '../../../support/wrap_with_localization.dart';

class _FakeAskAiClient implements AskAiClient {
  _FakeAskAiClient(this._events);

  final Stream<AskAiEvent> Function() _events;

  @override
  Stream<AskAiEvent> ask({
    required String studentId,
    required String question,
    String? conversationId,
    String? materialId,
    String level = 'high',
  }) => _events();
}

class _RecordingAskAiClient implements AskAiClient {
  _RecordingAskAiClient(this._onAsk);

  final void Function(String question, String? materialId) _onAsk;

  @override
  Stream<AskAiEvent> ask({
    required String studentId,
    required String question,
    String? conversationId,
    String? materialId,
    String level = 'high',
  }) {
    _onAsk(question, materialId);
    return Stream.fromIterable([
      const AskAiDoneEvent(messageId: 'msg-1', text: 'Start with chapter 4.', citations: []),
    ]);
  }
}

/// A picker that hands back [bytes] (or nothing, like a cancelled picker) for any source.
class _FakePhotoPicker implements AiPhotoPicker {
  _FakePhotoPicker(this.bytes);

  final Uint8List? bytes;
  final sources = <ImageSource>[];

  @override
  Future<Uint8List?> pick(ImageSource source) async {
    sources.add(source);
    return bytes;
  }
}

class _FakePhotoTextClient implements AiPhotoTextClient {
  _FakePhotoTextClient(this.result);

  final AiPhotoText result;
  final formatsRead = <AiPhotoFormat>[];

  @override
  Future<AiPhotoText> read(Uint8List bytes, AiPhotoFormat format) async {
    formatsRead.add(format);
    return result;
  }
}

final _jpeg = Uint8List.fromList([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

Widget _screen({
  required AskAiClient client,
  String? studentId = 'student-1',
  AskAiMaterialScope? initialMaterial,
  AiPhotoPicker? picker,
  AiPhotoTextClient? photoClient,
}) {
  return wrapWithLocalization(
    ProviderScope(
      overrides: [
        askAiClientProvider.overrideWithValue(client),
        askAiStudentIdProvider.overrideWithValue(studentId),
        if (picker != null) aiPhotoPickerProvider.overrideWithValue(picker),
        if (photoClient != null) aiPhotoTextClientProvider.overrideWithValue(photoClient),
      ],
      child: Builder(
        builder: (context) => MaterialApp(
          theme: AppTheme.light,
          debugShowCheckedModeBanner: false,
          locale: context.locale,
          supportedLocales: context.supportedLocales,
          localizationsDelegates: context.localizationDelegates,
          home: AskAiScreen(initialMaterial: initialMaterial),
        ),
      ),
    ),
  );
}

Future<void> _ask(WidgetTester tester, String question) async {
  await tester.enterText(find.byType(TextField).first, question);
  await tester.pump();
  await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('shows the signed-out notice when there is no session', (tester) async {
    await tester.pumpWidget(
      _screen(client: _FakeAskAiClient(() => const Stream.empty()), studentId: null),
    );
    await tester.pumpAndSettle();

    expect(find.text('Sign in to ask the study assistant a question.'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('shows the empty state before any question', (tester) async {
    await tester.pumpWidget(_screen(client: _FakeAskAiClient(() => const Stream.empty())));
    await tester.pumpAndSettle();

    expect(find.text('Ask about your study materials'), findsOneWidget);
  });

  testWidgets('a question opened from a material is asked about that material only', (
    tester,
  ) async {
    final asked = <(String, String?)>[];
    await tester.pumpWidget(
      _screen(
        client: _RecordingAskAiClient((question, materialId) => asked.add((question, materialId))),
        initialMaterial: const AskAiMaterialScope(id: 'mat-1', title: 'Biology Unit 3'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Asking about: Biology Unit 3'), findsOneWidget);
    expect(find.text('Answers come only from Biology Unit 3.'), findsOneWidget);

    await _ask(tester, 'What is osmosis?');
    expect(asked, [('What is osmosis?', 'mat-1')]);

    // Removing the chip goes back to every material for the next question.
    await tester.tap(find.byTooltip('Ask about all materials'));
    await tester.pumpAndSettle();
    expect(find.text('Asking about: Biology Unit 3'), findsNothing);

    await _ask(tester, 'And diffusion?');
    expect(asked.last, ('And diffusion?', null));
  });

  testWidgets('a photo\'s text is put into the field to check before sending', (tester) async {
    final picker = _FakePhotoPicker(_jpeg);
    final photoClient = _FakePhotoTextClient(
      const AiPhotoText(text: 'Explain question 3', truncated: false, confidence: 93),
    );
    await tester.pumpWidget(
      _screen(
        client: _FakeAskAiClient(() => const Stream.empty()),
        picker: picker,
        photoClient: photoClient,
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'Help me with:');
    await tester.tap(find.byTooltip('Add a photo or material'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Choose a photo'));
    await tester.pumpAndSettle();

    expect(picker.sources, [ImageSource.gallery]);
    expect(photoClient.formatsRead, [AiPhotoFormat.jpeg]);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      'Help me with:\n\nExplain question 3',
    );
    // Nothing is sent until the student sends it.
    expect(find.text('Ask about your study materials'), findsOneWidget);
  });

  testWidgets('a hard-to-read photo asks the student to check the text', (tester) async {
    await tester.pumpWidget(
      _screen(
        client: _FakeAskAiClient(() => const Stream.empty()),
        picker: _FakePhotoPicker(_jpeg),
        photoClient: _FakePhotoTextClient(
          const AiPhotoText(text: 'Expl4in qvestion', truncated: false, confidence: 41),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Add a photo or material'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Take a photo'));
    await tester.pumpAndSettle();

    expect(find.text('Some of the text may be wrong. Check it before sending.'), findsOneWidget);
  });

  testWidgets('a file that is not a JPEG or PNG is never uploaded', (tester) async {
    final photoClient = _FakePhotoTextClient(
      const AiPhotoText(text: 'x', truncated: false, confidence: 99),
    );
    await tester.pumpWidget(
      _screen(
        client: _FakeAskAiClient(() => const Stream.empty()),
        picker: _FakePhotoPicker(Uint8List.fromList('GIF89a'.codeUnits)),
        photoClient: photoClient,
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Add a photo or material'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Choose a photo'));
    await tester.pumpAndSettle();

    expect(photoClient.formatsRead, isEmpty);
    expect(find.text('Only JPEG or PNG photos can be read.'), findsOneWidget);
  });

  testWidgets('the send button sits centred in a single-line composer', (tester) async {
    await tester.pumpWidget(_screen(client: _FakeAskAiClient(() => const Stream.empty())));
    await tester.pumpAndSettle();

    final field = tester.getRect(
      find.ancestor(of: find.byType(TextField), matching: find.byType(AnimatedContainer)),
    );
    final button = tester.getRect(find.byTooltip('Send'));
    expect(button.center.dy, field.center.dy);
    expect(field.bottom - button.bottom, field.right - button.right);
  });

  testWidgets('tapping a suggested prompt sends it as the first question', (tester) async {
    String? asked;
    final client = _RecordingAskAiClient((question, _) => asked = question);
    await tester.pumpWidget(_screen(client: client));
    await tester.pumpAndSettle();

    const prompt = 'What should I review before my next test?';
    await tester.tap(find.text(prompt));
    await tester.pumpAndSettle();

    expect(asked, prompt);
    expect(find.text('Ask about your study materials'), findsNothing);
    expect(find.text(prompt), findsOneWidget);
  });

  testWidgets('streams an answer and renders its citation chip and report action', (tester) async {
    final client = _FakeAskAiClient(
      () => Stream.fromIterable([
        const AskAiSourcesEvent(conversationId: 'conv-1', sources: []),
        const AskAiDeltaEvent('Light '),
        const AskAiDeltaEvent('reactions.'),
        const AskAiDoneEvent(
          messageId: 'msg-1',
          text: 'Light reactions split water. [1]',
          citations: [
            AskAiCitation(
              order: 1,
              chunkId: 'c1',
              materialId: 'm1',
              materialTitle: 'Biology Unit 3',
              pageNumber: 12,
            ),
          ],
        ),
      ]),
    );
    await tester.pumpWidget(_screen(client: client));
    await tester.pumpAndSettle();

    await _ask(tester, 'How do light reactions work?');

    expect(find.text('How do light reactions work?'), findsOneWidget);
    expect(find.text('Light reactions split water. [1]'), findsOneWidget);
    expect(find.byType(AskAiCitationChip), findsOneWidget);
    expect(find.textContaining('Biology Unit 3'), findsOneWidget);
    expect(find.text('Report answer'), findsOneWidget);
  });

  testWidgets('renders a grounding refusal distinctly from an answer', (tester) async {
    final client = _FakeAskAiClient(
      () => Stream.fromIterable([
        const AskAiRefusalEvent([
          AskAiNearestTopic(chunkId: 'c1', materialTitle: 'Algebra Basics'),
        ]),
      ]),
    );
    await tester.pumpWidget(_screen(client: client));
    await tester.pumpAndSettle();

    await _ask(tester, 'Prove Fermat’s last theorem');

    expect(find.text('Not enough to answer that'), findsOneWidget);
    expect(find.textContaining('Algebra Basics'), findsOneWidget);
    expect(find.text('Report answer'), findsNothing);
  });

  testWidgets('a quota problem renders the send-error banner', (tester) async {
    final client = _FakeAskAiClient(
      () => Stream<AskAiEvent>.error(
        const ApiException(status: 429, title: 'quota', code: 'AI_QUOTA_EXCEEDED'),
      ),
    );
    await tester.pumpWidget(_screen(client: client));
    await tester.pumpAndSettle();

    await _ask(tester, 'anything');

    expect(find.text("You've used up this month's AI questions."), findsOneWidget);
  });
}
