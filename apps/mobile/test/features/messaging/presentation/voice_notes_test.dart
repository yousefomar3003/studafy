import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/messaging/application/messaging_providers.dart';
import 'package:studafy_mobile/src/features/messaging/application/voice_note_controllers.dart';
import 'package:studafy_mobile/src/features/messaging/data/voice_note_audio.dart';
import 'package:studafy_mobile/src/features/messaging/domain/messaging.dart';
import 'package:studafy_mobile/src/features/messaging/presentation/chat_screen.dart';
import 'package:studafy_mobile/src/features/messaging/presentation/widgets/conversation_tile.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

class _FakeRecorder implements VoiceNoteRecorder {
  bool allow = true;
  bool started = false;
  bool cancelled = false;
  final levelsController = StreamController<double>.broadcast();

  @override
  Future<bool> requestPermission() async => allow;

  @override
  Future<void> start() async => started = true;

  @override
  Future<RecordedVoiceNote?> stop() async =>
      const RecordedVoiceNote(path: '/tmp/voice-note-test.m4a', sizeBytes: 48000);

  @override
  Future<void> cancel() async => cancelled = true;

  @override
  Stream<double> levels() => levelsController.stream;

  @override
  Future<void> dispose() async {}
}

class _FakePlayer implements VoiceNotePlayer {
  final played = <String>[];
  final speeds = <double>[];
  int stops = 0;
  final _positions = StreamController<Duration>.broadcast();
  final _statuses = StreamController<VoicePlaybackStatus>.broadcast();

  @override
  Future<void> play(String source) async => played.add(source);

  @override
  Future<void> pause() async {}

  @override
  Future<void> resume() async {}

  @override
  Future<void> stop() async => stops++;

  @override
  Future<void> seek(Duration position) async {}

  @override
  Future<void> setSpeed(double speed) async => speeds.add(speed);

  @override
  Stream<Duration> get positions => _positions.stream;

  @override
  Stream<VoicePlaybackStatus> get statuses => _statuses.stream;

  @override
  Future<void> dispose() async {}
}

Conversation _conversation({bool voiceNotesAllowed = true, bool lastIsVoice = false}) =>
    Conversation.fromJson({
      ...conversationJson(lastBody: lastIsVoice ? '' : 'See you tomorrow'),
      if (lastIsVoice)
        'last_message': {
          'body': '',
          'attachment_count': 1,
          'voice_note': true,
          'sender_id': teacherUserId,
          'created_at': fixedNow.toUtc().toIso8601String(),
        },
      'voice_notes_allowed': voiceNotesAllowed,
    });

ChatMessage _voiceMessage(String id, {String? url = 'https://storage.test/note.m4a'}) =>
    ChatMessage(
      id: id,
      conversationId: 'conv-1',
      senderId: teacherUserId,
      body: '',
      createdAt: fixedNow.subtract(const Duration(minutes: 10)),
      attachments: [
        MessageAttachment(
          id: 'att-$id',
          contentType: 'audio/mp4',
          sizeBytes: 64000,
          downloadUrl: url,
          downloadUrlExpiresAt: fixedNow.add(const Duration(minutes: 5)),
          durationMs: 65000,
        ),
      ],
    );

late DateTime _clock;

Future<void> _pump(
  WidgetTester tester,
  FakeMessagingClient client, {
  required _FakeRecorder recorder,
  required _FakePlayer player,
  Conversation? conversation,
  Widget? home,
}) async {
  _clock = fixedNow;
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          messagingClientProvider.overrideWithValue(client),
          messagingUserIdProvider.overrideWithValue(parentUserId),
          chatClockProvider.overrideWithValue(() => fixedNow),
          voiceNoteRecorderProvider.overrideWithValue(recorder),
          voiceNotePlayerProvider.overrideWithValue(player),
          voiceNoteClockProvider.overrideWithValue(() => _clock),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home:
                home ??
                ChatScreen(
                  conversation: conversation ?? _conversation(),
                  viewer: MessagingViewer.parent,
                ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// Advances the recording clock and lets the 100 ms ticker see it.
Future<void> _advance(WidgetTester tester, Duration by) async {
  _clock = _clock.add(by);
  await tester.pump(const Duration(milliseconds: 150));
}

Future<void> _dispose(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
}

FakeMessagingClient _client({List<ChatMessage> messages = const []}) => FakeMessagingClient(
  conversations: [_conversation()],
  messages: {
    'conv-1': [...messages],
  },
);

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('record, preview and send a voice note', (tester) async {
    final client = _client();
    final recorder = _FakeRecorder();
    final player = _FakePlayer();
    await _pump(tester, client, recorder: recorder, player: player);

    // An empty composer offers the microphone instead of send.
    expect(find.byTooltip('Send'), findsNothing);
    await tester.tap(find.byTooltip('Record a voice message'));
    await tester.pump();
    await tester.pump();
    expect(recorder.started, isTrue);
    expect(find.byTooltip('Stop recording'), findsOneWidget);

    await _advance(tester, const Duration(seconds: 7));
    expect(find.text('0:07 / 2:00'), findsOneWidget);

    await tester.tap(find.byTooltip('Stop recording'));
    await tester.pump();
    await tester.pump();
    // The preview: play it back, delete it, or send it.
    expect(find.byTooltip('Send voice message'), findsOneWidget);
    expect(find.text('0:07'), findsOneWidget);

    await tester.tap(find.byTooltip('Send voice message'));
    await tester.pump();
    await tester.pump();
    await tester.pump();

    expect(client.uploadContentClasses, ['message.voice']);
    expect(client.uploadRequests.single.contentType, 'audio/mp4');
    expect(client.uploadRequests.single.sizeBytes, 48000);
    expect(client.sentVoiceNotes.single.duration, const Duration(seconds: 7));
    // Back to the composer, and the note is in the chat with its length.
    expect(find.byTooltip('Record a voice message'), findsOneWidget);
    expect(find.byTooltip('Play voice message'), findsOneWidget);
    await _dispose(tester);
  });

  testWidgets('a refused microphone says how to turn it on and keeps the composer', (tester) async {
    final recorder = _FakeRecorder()..allow = false;
    await _pump(tester, _client(), recorder: recorder, player: _FakePlayer());

    await tester.tap(find.byTooltip('Record a voice message'));
    await tester.pump();
    await tester.pump();

    expect(recorder.started, isFalse);
    expect(
      find.text('Microphone access is off. Turn it on in Settings to record voice messages.'),
      findsOneWidget,
    );
    expect(find.byTooltip('Record a voice message'), findsOneWidget);
    await _dispose(tester);
  });

  testWidgets('deleting while recording sends nothing', (tester) async {
    final client = _client();
    final recorder = _FakeRecorder();
    await _pump(tester, client, recorder: recorder, player: _FakePlayer());

    await tester.tap(find.byTooltip('Record a voice message'));
    await tester.pump();
    await tester.pump();
    await _advance(tester, const Duration(seconds: 3));
    await tester.tap(find.byTooltip('Delete voice message'));
    await tester.pump();

    expect(recorder.cancelled, isTrue);
    expect(client.uploadRequests, isEmpty);
    expect(client.sentVoiceNotes, isEmpty);
    expect(find.byTooltip('Record a voice message'), findsOneWidget);
    await _dispose(tester);
  });

  testWidgets('recording stops by itself at two minutes', (tester) async {
    final recorder = _FakeRecorder();
    await _pump(tester, _client(), recorder: recorder, player: _FakePlayer());

    await tester.tap(find.byTooltip('Record a voice message'));
    await tester.pump();
    await tester.pump();
    await _advance(tester, const Duration(minutes: 2, seconds: 5));
    await tester.pump();
    await tester.pump();

    expect(find.byTooltip('Send voice message'), findsOneWidget);
    expect(find.text('2:00'), findsOneWidget);
    await _dispose(tester);
  });

  testWidgets('a school with voice notes off shows no microphone', (tester) async {
    await _pump(
      tester,
      _client(),
      recorder: _FakeRecorder(),
      player: _FakePlayer(),
      conversation: _conversation(voiceNotesAllowed: false),
    );

    expect(find.byTooltip('Record a voice message'), findsNothing);
    expect(find.byTooltip('Send'), findsOneWidget);
    await _dispose(tester);
  });

  testWidgets('a received note plays, changes speed, and one plays at a time', (tester) async {
    final player = _FakePlayer();
    await _pump(
      tester,
      _client(messages: [_voiceMessage('v1'), _voiceMessage('v2')]),
      recorder: _FakeRecorder(),
      player: player,
    );

    expect(find.text('1:05'), findsNWidgets(2));
    await tester.tap(find.byTooltip('Play voice message').first);
    await tester.pump();
    expect(player.played, ['https://storage.test/note.m4a']);
    expect(find.byTooltip('Pause voice message'), findsOneWidget);

    await tester.tap(find.text('1×').first);
    await tester.pump();
    expect(player.speeds, [1.5]);
    expect(find.text('1.5×'), findsNWidgets(2));

    // Starting the other note stops the first.
    final stopsBefore = player.stops;
    await tester.tap(find.byTooltip('Play voice message').first);
    await tester.pump();
    expect(player.stops, stopsBefore + 1);
    expect(player.played, hasLength(2));
    expect(find.byTooltip('Pause voice message'), findsOneWidget);
    await _dispose(tester);
  });

  testWidgets('a note still being scanned says so instead of offering play', (tester) async {
    await _pump(
      tester,
      _client(messages: [_voiceMessage('v1', url: null)]),
      recorder: _FakeRecorder(),
      player: _FakePlayer(),
    );

    expect(find.text('Checking for safety…'), findsOneWidget);
    expect(find.byTooltip('Play voice message'), findsNothing);
    await _dispose(tester);
  });

  testWidgets('the school turning voice notes off mid-chat explains the failed send', (
    tester,
  ) async {
    final client = _client()..sendError = apiError(403, 'MESSAGING_VOICE_NOTES_DISABLED');
    await _pump(tester, client, recorder: _FakeRecorder(), player: _FakePlayer());

    await tester.tap(find.byTooltip('Record a voice message'));
    await tester.pump();
    await tester.pump();
    await _advance(tester, const Duration(seconds: 2));
    await tester.tap(find.byTooltip('Stop recording'));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.byTooltip('Send voice message'));
    await tester.pump();
    await tester.pump();
    await tester.pump();

    expect(find.text('Your school has turned off voice messages'), findsOneWidget);
    await _dispose(tester);
  });

  testWidgets('the inbox previews a voice note', (tester) async {
    await tester.pumpWidget(
      wrapWithLocalization(
        Builder(
          builder: (context) => MaterialApp(
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: Scaffold(
              body: ConversationTile(
                conversation: _conversation(lastIsVoice: true),
                viewer: MessagingViewer.parent,
                myUserId: parentUserId,
                onTap: () {},
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('Voice message'), findsOneWidget);
  });
}
