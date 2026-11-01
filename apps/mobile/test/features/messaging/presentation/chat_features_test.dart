import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/messaging/application/chat_draft_controller.dart';
import 'package:studafy_mobile/src/features/messaging/application/messaging_providers.dart';
import 'package:studafy_mobile/src/features/messaging/data/chat_image_picker.dart';
import 'package:studafy_mobile/src/features/messaging/domain/draft_attachment.dart';
import 'package:studafy_mobile/src/features/messaging/domain/messaging.dart';
import 'package:studafy_mobile/src/features/messaging/presentation/chat_screen.dart';
import 'package:studafy_mobile/src/features/messaging/presentation/widgets/chat_bubble.dart';
import 'package:studafy_mobile/src/features/messaging/presentation/widgets/chat_image.dart';
import 'package:studafy_mobile/src/features/messaging/presentation/widgets/conversation_tile.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

class _FakePicker extends ChatImagePicker {
  _FakePicker(this.gallery);

  final List<PickedImage> gallery;
  final limits = <int>[];

  @override
  Future<List<PickedImage>> pickFromGallery({required int limit}) async {
    limits.add(limit);
    return gallery.take(limit).toList();
  }

  @override
  Future<PickedImage?> takePhoto() async => null;
}

Future<void> _pump(
  WidgetTester tester,
  FakeMessagingClient client, {
  Conversation? conversation,
  MessagingViewer viewer = MessagingViewer.parent,
  ChatImagePicker? picker,
  Widget? home,
}) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          messagingClientProvider.overrideWithValue(client),
          messagingUserIdProvider.overrideWithValue(
            viewer == MessagingViewer.parent ? parentUserId : teacherUserId,
          ),
          chatClockProvider.overrideWithValue(() => fixedNow),
          if (picker != null) chatImagePickerProvider.overrideWithValue(picker),
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
                  conversation: conversation ?? conversationFixture(),
                  viewer: viewer,
                ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _dispose(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
}

FakeMessagingClient _client({
  List<ChatMessage>? messages,
  Conversation? conversation,
}) => FakeMessagingClient(
  conversations: [conversation ?? conversationFixture()],
  messages: {
    'conv-1':
        messages ??
        [
          messageFixture(
            'm1',
            senderId: teacherUserId,
            body: 'Amir did well today',
            at: fixedNow.subtract(const Duration(minutes: 20)),
          ),
        ],
  },
);

Future<void> _openMenuItem(WidgetTester tester, String label) async {
  await tester.tap(find.byTooltip('More options'));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

ParticipantProfile _teacherProfile() => ParticipantProfile.fromJson({
  'user_id': teacherUserId,
  'name': 'Rana Haddad',
  'role': 'teacher',
  'blocked_by_me': false,
  'has_blocked_me': false,
  'classes': [
    {
      'id': 'k1',
      'code': '7A',
      'course_name': 'Math 7',
      'subject_name': 'Mathematics',
    },
  ],
  'subjects': ['Mathematics', 'Physics'],
  'relationship': null,
  'children': <Object?>[],
});

ParticipantProfile _parentProfile() => ParticipantProfile.fromJson({
  'user_id': parentUserId,
  'name': 'Bassel Fares',
  'role': 'parent',
  'blocked_by_me': false,
  'has_blocked_me': false,
  'classes': <Object?>[],
  'subjects': <Object?>[],
  'relationship': 'father',
  'children': [
    {
      'id': 'child-1',
      'name': 'Amir',
      'relationship': 'father',
      'is_conversation_student': true,
      'classes': [
        {'id': 'k1', 'code': '7A', 'course_name': 'Math 7'},
      ],
    },
    {
      'id': 'child-2',
      'name': 'Lina',
      'relationship': 'father',
      'is_conversation_student': false,
      'classes': [
        {'id': 'k2', 'code': '5C', 'course_name': null},
      ],
    },
  ],
});

void main() {
  setUpAll(ensureDateFormattingInitialized);

  group('images', () {
    testWidgets(
      'an image-only message renders its images without a text area',
      (tester) async {
        final client = _client(
          messages: [
            messageFixture(
              'm1',
              body: '',
              at: fixedNow.subtract(const Duration(minutes: 3)),
              attachments: [attachmentFixture('a1'), attachmentFixture('a2')],
            ),
          ],
        );
        await _pump(tester, client);

        expect(find.bySemanticsLabel('Photo 1 of 2'), findsOneWidget);
        expect(find.bySemanticsLabel('Photo 2 of 2'), findsOneWidget);
        expect(find.byType(ChatImageView), findsNWidgets(2));
        final images = tester.widgetList<Image>(find.byType(Image)).toList();
        expect(
          // Bubbles decode at display size, so each NetworkImage is wrapped in a ResizeImage.
          images.map((image) => ((image.image as ResizeImage).imageProvider as NetworkImage).url),
          containsAll([
            'https://storage.test/a1.jpg',
            'https://storage.test/a2.jpg',
          ]),
        );
        // No empty text area in the image-only bubble.
        expect(
          find.descendant(of: find.byType(ChatBubble), matching: find.text('')),
          findsNothing,
        );

        await _dispose(tester);
      },
    );

    testWidgets(
      'a failing image (expired URL) triggers a refetch of the messages',
      (tester) async {
        final client = _client(
          messages: [
            messageFixture(
              'm1',
              body: 'Look',
              at: fixedNow.subtract(const Duration(minutes: 3)),
              attachments: [attachmentFixture('a1')],
            ),
          ],
        );
        await _pump(tester, client);
        int fullLoads() => client.listMessageCalls
            .where((c) => c.since == null && c.before == null)
            .length;

        // flutter_test answers every HTTP request with 400, so the network image fails.
        for (var i = 0; i < 10 && fullLoads() < 2; i++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 50)),
          );
          await tester.pump();
        }

        expect(
          fullLoads(),
          2,
          reason: 'the first page, then one refresh for fresh URLs',
        );

        await _dispose(tester);
      },
    );

    testWidgets('tapping an image opens the full-screen viewer', (
      tester,
    ) async {
      final client = _client(
        messages: [
          messageFixture(
            'm1',
            body: '',
            at: fixedNow.subtract(const Duration(minutes: 3)),
            attachments: [attachmentFixture('a1'), attachmentFixture('a2')],
          ),
        ],
      );
      await _pump(tester, client);

      await tester.tap(find.bySemanticsLabel('Photo 2 of 2'));
      await tester.pumpAndSettle();

      expect(find.byType(ChatImageViewer), findsOneWidget);
      expect(find.text('2 / 2'), findsOneWidget);
      expect(find.byType(InteractiveViewer), findsWidgets);

      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      expect(find.byType(ChatImageViewer), findsNothing);

      await _dispose(tester);
    });

    testWidgets('picked images upload, then send with an empty body enabled', (
      tester,
    ) async {
      final client = _client();
      final picker = _FakePicker([
        const PickedImage(
          path: '/tmp/a.jpg',
          fileName: 'a.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 2048,
        ),
        const PickedImage(
          path: '/tmp/b.gif',
          fileName: 'b.gif',
          contentType: 'image/gif',
          sizeBytes: 2048,
        ),
      ]);
      await _pump(tester, client, picker: picker);

      await tester.tap(find.byTooltip('Attach photos'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Photo library'));
      await tester.pumpAndSettle();

      expect(picker.limits, [4]);
      expect(
        find.text('Only JPEG, PNG, WebP or HEIC photos can be sent.'),
        findsOneWidget,
      );
      expect(find.bySemanticsLabel('Photo ready to send'), findsOneWidget);
      expect(find.bySemanticsLabel('Remove photo'), findsOneWidget);

      // Out of the way of the composer.
      tester
          .state<ScaffoldMessengerState>(find.byType(ScaffoldMessenger))
          .removeCurrentSnackBar();
      await tester.pumpAndSettle();
      final send = tester.widget<IconButton>(
        find.widgetWithIcon(IconButton, Icons.arrow_upward),
      );
      expect(send.onPressed, isNotNull);
      await tester.tap(find.byIcon(Icons.arrow_upward));
      await tester.pumpAndSettle();

      expect(client.sentBodies, ['']);
      expect(client.sentStorageKeys.single, ['key-0']);
      expect(find.bySemanticsLabel('Remove photo'), findsNothing);
      expect(find.bySemanticsLabel(RegExp(r'^Photo 1 of 1$')), findsOneWidget);

      await _dispose(tester);
    });

    testWidgets('removing a draft image takes it out of the strip', (
      tester,
    ) async {
      final client = _client();
      final picker = _FakePicker([
        const PickedImage(
          path: '/tmp/a.jpg',
          fileName: 'a.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 2048,
        ),
      ]);
      await _pump(tester, client, picker: picker);

      await tester.tap(find.byTooltip('Attach photos'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Photo library'));
      await tester.pumpAndSettle();
      await tester.tap(find.bySemanticsLabel('Remove photo'));
      await tester.pumpAndSettle();

      expect(find.bySemanticsLabel('Photo ready to send'), findsNothing);
      final send = tester.widget<IconButton>(
        find.widgetWithIcon(IconButton, Icons.arrow_upward),
      );
      expect(send.onPressed, isNull);

      await _dispose(tester);
    });
  });

  group('blocking', () {
    testWidgets('blocked by me: a banner with Unblock replaces the composer', (
      tester,
    ) async {
      final client = _client();
      await _pump(
        tester,
        client,
        conversation: conversationFixture(blockedByMe: true),
      );

      expect(
        find.text('You blocked Rana Haddad. Unblock to send messages.'),
        findsOneWidget,
      );
      expect(find.byType(TextField), findsNothing);

      await tester.tap(find.widgetWithText(FilledButton, 'Unblock'));
      await tester.pumpAndSettle();

      expect(client.unblockCalls, ['conv-1']);
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text('Rana Haddad is unblocked.'), findsOneWidget);

      await _dispose(tester);
    });

    testWidgets('blocked by them: a banner and no composer', (tester) async {
      await _pump(
        tester,
        _client(),
        conversation: conversationFixture(hasBlockedMe: true),
      );

      expect(
        find.text("You can't reply in this conversation."),
        findsOneWidget,
      );
      expect(find.byType(TextField), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Unblock'), findsNothing);

      await _dispose(tester);
    });

    testWidgets(
      'a send refused with MESSAGING_BLOCKED switches to the blocked banner',
      (tester) async {
        final client = _client()
          ..sendError = apiError(403, 'MESSAGING_BLOCKED');
        await _pump(tester, client);

        await tester.enterText(find.byType(TextField), 'Hello');
        await tester.pump();
        await tester.tap(find.byIcon(Icons.arrow_upward));
        await tester.pumpAndSettle();

        expect(
          find.text("You can't reply in this conversation."),
          findsOneWidget,
        );
        expect(find.byType(TextField), findsNothing);

        await _dispose(tester);
      },
    );

    testWidgets('Block from the menu confirms first, then blocks', (
      tester,
    ) async {
      final client = _client();
      await _pump(tester, client);

      await _openMenuItem(tester, 'Block');
      expect(find.text('Block Rana Haddad?'), findsOneWidget);
      expect(find.textContaining('Your message history stays'), findsOneWidget);

      await tester.tap(find.widgetWithText(FilledButton, 'Block'));
      await tester.pumpAndSettle();

      expect(client.blockCalls, ['conv-1']);
      expect(
        find.text('You blocked Rana Haddad. Unblock to send messages.'),
        findsOneWidget,
      );

      // The menu now offers Unblock instead.
      await tester.tap(find.byTooltip('More options'));
      await tester.pumpAndSettle();
      expect(find.text('Unblock'), findsWidgets);
      expect(find.widgetWithText(PopupMenuItem<Object>, 'Block'), findsNothing);

      await _dispose(tester);
    });

    testWidgets('a blocked conversation shows an indicator in the list', (
      tester,
    ) async {
      await _pump(
        tester,
        _client(),
        home: Scaffold(
          body: ConversationTile(
            conversation: conversationFixture(
              blockedByMe: true,
              lastBody: '',
              attachmentCount: 2,
            ),
            viewer: MessagingViewer.parent,
            myUserId: parentUserId,
            onTap: () {},
          ),
        ),
      );

      expect(find.byIcon(Icons.block), findsOneWidget);
      expect(find.text('📷 Photos'), findsOneWidget);
    });

    testWidgets('an image-only preview of mine reads "You: 📷 Photo"', (
      tester,
    ) async {
      await _pump(
        tester,
        _client(),
        home: Scaffold(
          body: ConversationTile(
            conversation: conversationFixture(
              lastBody: '',
              attachmentCount: 1,
              lastSenderId: parentUserId,
            ),
            viewer: MessagingViewer.parent,
            myUserId: parentUserId,
            onTap: () {},
          ),
        ),
      );

      expect(find.text('You: 📷 Photo'), findsOneWidget);
      expect(find.byIcon(Icons.block), findsNothing);
    });
  });

  group('report', () {
    testWidgets('reporting the conversation (and blocking) from the menu', (
      tester,
    ) async {
      final client = _client();
      await _pump(tester, client);

      await _openMenuItem(tester, 'Report Rana Haddad');
      expect(find.text('Report Rana Haddad'), findsOneWidget);
      final submit = find.widgetWithText(FilledButton, 'Send report');
      expect(
        tester.widget<FilledButton>(submit).onPressed,
        isNull,
        reason: 'reason required',
      );

      await tester.tap(find.text('Spam'));
      await tester.pump();
      await tester.enterText(find.byType(TextField).last, '  Sends ads  ');
      await tester.tap(find.text('Also block Rana Haddad'));
      await tester.pump();
      await tester.tap(submit);
      await tester.pumpAndSettle();

      final call = client.reportCalls.single;
      expect(call.reason, ReportReason.spam);
      expect(call.messageId, isNull);
      expect(call.details, '  Sends ads  ');
      expect(call.alsoBlock, isTrue);
      expect(find.text('Report sent to the school'), findsOneWidget);
      expect(
        find.text('You blocked Rana Haddad. Unblock to send messages.'),
        findsOneWidget,
      );

      await _dispose(tester);
    });

    testWidgets('an already-open report says the school is reviewing it', (
      tester,
    ) async {
      final client = _client()
        ..reportError = apiError(409, 'MESSAGE_REPORT_ALREADY_OPEN');
      await _pump(tester, client);

      await _openMenuItem(tester, 'Report Rana Haddad');
      await tester.tap(find.text('Harassment or bullying'));
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Send report'));
      await tester.pumpAndSettle();

      expect(
        find.text("You've already reported this; the school is reviewing it."),
        findsOneWidget,
      );
      expect(
        find.text('Send report'),
        findsNothing,
        reason: 'the sheet closed',
      );
      expect(find.byType(TextField), findsOneWidget, reason: 'not blocked');

      await _dispose(tester);
    });

    testWidgets('any other failure stays in the sheet with an error', (
      tester,
    ) async {
      final client = _client()..reportError = StateError('offline');
      await _pump(tester, client);

      await _openMenuItem(tester, 'Report Rana Haddad');
      await tester.tap(find.text('Something else'));
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Send report'));
      await tester.pumpAndSettle();

      expect(
        find.text("Couldn't send the report. Please try again."),
        findsOneWidget,
      );
      expect(find.text('Send report'), findsOneWidget);

      await _dispose(tester);
    });

    testWidgets("long-pressing the other side's message reports that message", (
      tester,
    ) async {
      final client = _client();
      await _pump(tester, client);

      await tester.longPress(find.text('Amir did well today'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Report message'));
      await tester.pumpAndSettle();

      expect(
        find.text('Report message'),
        findsOneWidget,
        reason: 'the sheet title',
      );
      await tester.tap(find.text('Inappropriate content'));
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Send report'));
      await tester.pumpAndSettle();

      expect(client.reportCalls.single.messageId, 'm1');
      expect(client.reportCalls.single.reason, ReportReason.inappropriate);
      expect(client.reportCalls.single.alsoBlock, isFalse);
      expect(find.text('Report sent to the school'), findsOneWidget);

      await _dispose(tester);
    });
  });

  group('profile', () {
    testWidgets(
      'a parent sees the teacher: classes with the child and subjects',
      (tester) async {
        final client = _client()..profiles = {'conv-1': _teacherProfile()};
        await _pump(tester, client);

        await tester.tap(find.bySemanticsLabel("View Rana Haddad's profile"));
        await tester.pumpAndSettle();

        expect(client.profileCalls, ['conv-1']);
        expect(find.text('Teacher'), findsOneWidget);
        expect(find.text('Teaches Amir'), findsOneWidget);
        expect(find.text('7A · Math 7 · Mathematics'), findsOneWidget);
        expect(find.text('Subjects'), findsOneWidget);
        expect(find.widgetWithText(Chip, 'Mathematics'), findsOneWidget);
        expect(find.widgetWithText(Chip, 'Physics'), findsOneWidget);

        // Block from the profile.
        await tester.tap(find.widgetWithText(OutlinedButton, 'Block'));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Block'));
        await tester.pumpAndSettle();
        expect(client.blockCalls, ['conv-1']);
        expect(find.widgetWithText(OutlinedButton, 'Unblock'), findsOneWidget);

        await _dispose(tester);
      },
    );

    testWidgets(
      'a teacher sees the parent: relationship and the children they teach',
      (tester) async {
        final client = _client()..profiles = {'conv-1': _parentProfile()};
        await _pump(tester, client, viewer: MessagingViewer.teacher);

        await _openMenuItem(tester, 'View profile');

        expect(find.text('Bassel Fares'), findsWidgets);
        expect(find.text('Father of Amir'), findsOneWidget);
        expect(find.text('Children you teach'), findsOneWidget);
        expect(find.text('Amir'), findsOneWidget);
        expect(find.text('Lina'), findsOneWidget);
        expect(find.text('This conversation'), findsOneWidget);
        expect(find.text('7A · Math 7'), findsOneWidget);
        expect(find.text('5C'), findsOneWidget);

        await _dispose(tester);
      },
    );

    testWidgets('a failed profile load can be retried', (tester) async {
      final client = _client()..profileError = StateError('offline');
      await _pump(tester, client);

      await _openMenuItem(tester, 'View profile');
      expect(find.text("Couldn't load this profile."), findsOneWidget);

      client
        ..profileError = null
        ..profiles = {'conv-1': _teacherProfile()};
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();

      expect(find.text('Teaches Amir'), findsOneWidget);

      await _dispose(tester);
    });
  });
}
