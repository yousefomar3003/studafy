import 'package:drift/native.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/offline/offline_database.dart';
import 'package:studafy_mobile/src/core/offline/offline_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/messaging/application/messaging_providers.dart';
import 'package:studafy_mobile/src/features/messaging/domain/messaging.dart';
import 'package:studafy_mobile/src/features/messaging/presentation/chat_screen.dart';
import 'package:studafy_mobile/src/features/messaging/presentation/parent_messages_screen.dart';
import 'package:studafy_mobile/src/features/messaging/presentation/teacher_messages_screen.dart';
import 'package:studafy_mobile/src/features/messaging/presentation/teacher_messaging_contacts_screen.dart';
import 'package:studafy_mobile/src/features/parent/application/parent_providers.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../../parent/support.dart';
import '../support.dart';

Future<void> _pump(
  WidgetTester tester, {
  required Widget home,
  required FakeMessagingClient client,
  String userId = parentUserId,
  List<Override> overrides = const [],
}) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          offlineDatabaseProvider.overrideWithValue(
            OfflineDatabase(NativeDatabase.memory()),
          ),
          messagingClientProvider.overrideWithValue(client),
          messagingUserIdProvider.overrideWithValue(userId),
          chatClockProvider.overrideWithValue(() => fixedNow),
          ...overrides,
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: Scaffold(body: home),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Override _children(List<(String, String)> children) =>
    childComparisonProvider.overrideWith(
      (ref) => comparisonReport([
        for (final (id, name) in children) childItem(id: id, name: name),
      ]),
    );

FakeMessagingClient _parentClient() => FakeMessagingClient(
  conversations: [
    conversationFixture(lastBody: 'Amir did well today', unread: 2),
    conversationFixture(
      id: 'conv-2',
      studentId: 'child-2',
      studentName: 'Mira',
      teacherName: 'Omar Khalil',
      lastBody: 'Homework reminder',
    ),
  ],
  contacts: {
    'child-1': [
      MessagingContact(
        teacherId: 't1',
        name: 'Rana Haddad',
        classes: const [
          ContactClass(id: 'c1', code: 'SCI-7A', courseName: 'Science'),
        ],
        conversationId: 'conv-1',
      ),
      const MessagingContact(
        teacherId: 't2',
        name: 'Samer Nasser',
        classes: [ContactClass(id: 'c2', code: 'MATH-7A', courseName: null)],
        conversationId: null,
      ),
    ],
  },
  messages: {'conv-1': [], 'conv-new': []},
);

/// Pops any chat and tears the tree down so no poll timer outlives the test.
Future<void> _dispose(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  group('parent', () {
    testWidgets(
      'two children: switcher on top, rows for the selected child only',
      (tester) async {
        final client = _parentClient();
        await _pump(
          tester,
          home: const ParentMessagesScreen(),
          client: client,
          overrides: [
            _children([('child-1', 'Amir'), ('child-2', 'Mira')]),
          ],
        );

        expect(find.byType(ChoiceChip), findsNWidgets(2));
        expect(find.text('Rana Haddad'), findsOneWidget);
        expect(find.text('Science'), findsOneWidget);
        expect(find.text('Amir did well today'), findsOneWidget);
        expect(find.text('2'), findsOneWidget);
        expect(find.text('Omar Khalil'), findsNothing);
        expect(client.listConversationCalls, contains('child-1'));

        await tester.tap(find.widgetWithText(ChoiceChip, 'Mira'));
        await tester.pumpAndSettle();

        expect(find.text('Omar Khalil'), findsOneWidget);
        expect(find.text('Rana Haddad'), findsNothing);
      },
    );

    testWidgets('one child: no switcher', (tester) async {
      await _pump(
        tester,
        home: const ParentMessagesScreen(),
        client: _parentClient(),
        overrides: [
          _children([('child-1', 'Amir')]),
        ],
      );

      expect(find.byType(ChoiceChip), findsNothing);
      expect(find.text('Rana Haddad'), findsOneWidget);
    });

    testWidgets('no conversations: a friendly empty state naming the child', (
      tester,
    ) async {
      await _pump(
        tester,
        home: const ParentMessagesScreen(),
        client: FakeMessagingClient(),
        overrides: [
          _children([('child-1', 'Amir')]),
        ],
      );

      expect(find.text('No conversations yet.'), findsOneWidget);
      expect(
        find.text("Tap New message to write to one of Amir's teachers."),
        findsOneWidget,
      );
    });

    testWidgets('own last message previews as "You: …"', (tester) async {
      await _pump(
        tester,
        home: const ParentMessagesScreen(),
        client: FakeMessagingClient(
          conversations: [
            conversationFixture(
              lastBody: 'Thanks!',
              lastSenderId: parentUserId,
            ),
          ],
        ),
        overrides: [
          _children([('child-1', 'Amir')]),
        ],
      );

      expect(find.text('You: Thanks!'), findsOneWidget);
    });

    testWidgets(
      'new message: a new teacher starts a conversation and opens the chat',
      (tester) async {
        final client = _parentClient();
        await _pump(
          tester,
          home: const ParentMessagesScreen(),
          client: client,
          overrides: [
            _children([('child-1', 'Amir')]),
          ],
        );

        await tester.tap(find.text('New message'));
        await tester.pumpAndSettle();
        expect(find.text('Teachers of Amir'), findsOneWidget);
        expect(find.text('MATH-7A'), findsOneWidget);

        await tester.tap(find.text('Samer Nasser'));
        await tester.pumpAndSettle();

        expect(client.started.single, (studentId: 'child-1', teacherId: 't2'));
        expect(find.byType(ChatScreen), findsOneWidget);

        // Closing the chat lands back on the list (the picker was replaced) and refreshes it.
        final callsBefore = client.listConversationCalls.length;
        await tester.pageBack();
        await tester.pumpAndSettle();
        expect(find.byType(ChatScreen), findsNothing);
        expect(find.text('Teachers of Amir'), findsNothing);
        expect(client.listConversationCalls.length, greaterThan(callsBefore));

        await _dispose(tester);
      },
    );

    testWidgets(
      'new message: a teacher with a conversation reopens it, no create',
      (tester) async {
        final client = _parentClient();
        await _pump(
          tester,
          home: const ParentMessagesScreen(),
          client: client,
          overrides: [
            _children([('child-1', 'Amir')]),
          ],
        );

        await tester.tap(find.text('New message'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Rana Haddad'));
        await tester.pumpAndSettle();

        expect(client.started, isEmpty);
        expect(
          tester.widget<ChatScreen>(find.byType(ChatScreen)).conversation.id,
          'conv-1',
        );

        await _dispose(tester);
      },
    );
  });

  group('teacher', () {
    FakeMessagingClient teacherClient() => FakeMessagingClient(
      conversations: [conversationFixture(unread: 1)],
      teacherContacts: const [
        TeacherMessagingStudent(
          id: 'child-1',
          name: 'Amir',
          classes: [
            ContactClass(id: 'c1', code: 'SCI-7A', courseName: 'Science'),
          ],
          parents: [
            TeacherMessagingParent(
              parentId: parentUserId,
              name: 'Bassel Fares',
              relationship: 'father',
              conversationId: 'conv-1',
            ),
            TeacherMessagingParent(
              parentId: 'parent-2',
              name: 'Lina Fares',
              relationship: 'mother',
              conversationId: null,
            ),
          ],
        ),
        TeacherMessagingStudent(
          id: 'child-2',
          name: 'Mira',
          classes: [ContactClass(id: 'c2', code: 'MATH-7B', courseName: null)],
          parents: [
            TeacherMessagingParent(
              parentId: 'parent-3',
              name: 'Omar Khalil',
              relationship: 'guardian',
              conversationId: null,
            ),
          ],
        ),
      ],
      messages: {'conv-1': [], 'conv-new': []},
    );

    testWidgets(
      'rows name the parent and the student; tapping opens the chat',
      (tester) async {
        final client = teacherClient();
        await _pump(
          tester,
          home: const TeacherMessagesScreen(),
          client: client,
          userId: teacherUserId,
        );

        expect(find.text('Bassel Fares'), findsOneWidget);
        expect(find.text('re: Amir'), findsOneWidget);
        expect(find.text('New message'), findsOneWidget);
        expect(client.listConversationCalls, [null]);

        await tester.tap(find.text('Bassel Fares'));
        await tester.pumpAndSettle();
        final chat = tester.widget<ChatScreen>(find.byType(ChatScreen));
        expect(chat.viewer, MessagingViewer.teacher);

        await _dispose(tester);
      },
    );

    testWidgets('no conversations: the empty state points at New message', (
      tester,
    ) async {
      await _pump(
        tester,
        home: const TeacherMessagesScreen(),
        client: FakeMessagingClient(),
        userId: teacherUserId,
      );

      expect(find.text('No conversations yet.'), findsOneWidget);
      expect(
        find.text(
          'Tap New message to write to a parent of one of your students.',
        ),
        findsOneWidget,
      );
    });

    testWidgets(
      'new message: picking a new parent starts a conversation and opens the chat',
      (tester) async {
        final client = teacherClient();
        await _pump(
          tester,
          home: const TeacherMessagesScreen(),
          client: client,
          userId: teacherUserId,
        );

        await tester.tap(find.text('New message'));
        await tester.pumpAndSettle();
        expect(find.byType(TeacherMessagingContactsScreen), findsOneWidget);
        expect(find.text('Amir'), findsOneWidget);
        expect(find.text('Science'), findsOneWidget);
        expect(find.text('Mother'), findsOneWidget);
        expect(find.text('Guardian'), findsOneWidget);

        await tester.tap(find.text('Lina Fares'));
        await tester.pumpAndSettle();

        expect(client.startedByTeacher.single, (
          studentId: 'child-1',
          parentId: 'parent-2',
        ));
        final chat = tester.widget<ChatScreen>(find.byType(ChatScreen));
        expect(chat.conversation.id, 'conv-new');
        expect(chat.viewer, MessagingViewer.teacher);

        // Closing the chat lands back on the list (the picker was replaced) and refreshes it.
        final callsBefore = client.listConversationCalls.length;
        await tester.pageBack();
        await tester.pumpAndSettle();
        expect(find.byType(ChatScreen), findsNothing);
        expect(find.byType(TeacherMessagingContactsScreen), findsNothing);
        expect(client.listConversationCalls.length, greaterThan(callsBefore));

        await _dispose(tester);
      },
    );

    testWidgets(
      'new message: a parent with a conversation reopens it, no create',
      (tester) async {
        final client = teacherClient();
        await _pump(
          tester,
          home: const TeacherMessagesScreen(),
          client: client,
          userId: teacherUserId,
        );

        await tester.tap(find.text('New message'));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(ListTile, 'Bassel Fares'));
        await tester.pumpAndSettle();

        expect(client.startedByTeacher, isEmpty);
        expect(
          tester.widget<ChatScreen>(find.byType(ChatScreen)).conversation.id,
          'conv-1',
        );

        await _dispose(tester);
      },
    );

    testWidgets('new message: search narrows students and parents', (
      tester,
    ) async {
      await _pump(
        tester,
        home: const TeacherMessagesScreen(),
        client: teacherClient(),
        userId: teacherUserId,
      );

      await tester.tap(find.text('New message'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'omar');
      await tester.pumpAndSettle();
      expect(find.text('Mira'), findsOneWidget);
      expect(find.text('Omar Khalil'), findsOneWidget);
      expect(find.text('Amir'), findsNothing);

      await tester.enterText(find.byType(TextField), 'nobody');
      await tester.pumpAndSettle();
      expect(
        find.text('No students or parents match your search.'),
        findsOneWidget,
      );
    });

    testWidgets('new message: no messageable parents shows an empty state', (
      tester,
    ) async {
      await _pump(
        tester,
        home: const TeacherMessagesScreen(),
        client: FakeMessagingClient(),
        userId: teacherUserId,
      );

      await tester.tap(find.text('New message'));
      await tester.pumpAndSettle();
      expect(
        find.text('None of your students have a parent you can message yet.'),
        findsOneWidget,
      );
    });

    testWidgets(
      'new message: a failed open stays on the picker with a snackbar',
      (tester) async {
        final client = teacherClient()..startError = Exception('boom');
        await _pump(
          tester,
          home: const TeacherMessagesScreen(),
          client: client,
          userId: teacherUserId,
        );

        await tester.tap(find.text('New message'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Omar Khalil'));
        await tester.pumpAndSettle();

        expect(find.byType(ChatScreen), findsNothing);
        expect(find.byType(TeacherMessagingContactsScreen), findsOneWidget);
        expect(
          find.text("Couldn't open the conversation. Please try again."),
          findsOneWidget,
        );
      },
    );
  });
}
