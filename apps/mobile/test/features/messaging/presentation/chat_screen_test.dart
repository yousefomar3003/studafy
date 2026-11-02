import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/messaging/application/messaging_providers.dart';
import 'package:studafy_mobile/src/features/messaging/domain/messaging.dart';
import 'package:studafy_mobile/src/features/messaging/presentation/chat_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

Future<void> _pumpChat(
  WidgetTester tester,
  FakeMessagingClient client, {
  Locale locale = const Locale('en'),
}) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          messagingClientProvider.overrideWithValue(client),
          messagingUserIdProvider.overrideWithValue(parentUserId),
          chatClockProvider.overrideWithValue(() => fixedNow),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: ChatScreen(
              conversation: conversationFixture(),
              viewer: MessagingViewer.parent,
            ),
          ),
        ),
      ),
      startLocale: locale,
    ),
  );
  if (locale.languageCode == 'ar') {
    // ar.json is over the 50 KB threshold above which `rootBundle.loadString` decodes on a
    // background isolate, which never completes inside the test's fake-async zone.
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 300)),
    );
  }
  await tester.pumpAndSettle();
}

/// Tears the chat down so its poll timer is cancelled before the test ends.
Future<void> _dispose(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
}

FakeMessagingClient _clientWithThread() => FakeMessagingClient(
  conversations: [conversationFixture()],
  messages: {
    'conv-1': [
      messageFixture(
        'm1',
        senderId: teacherUserId,
        body: 'Amir did well today',
        at: fixedNow.subtract(const Duration(days: 1, hours: 2)),
      ),
      messageFixture(
        'm2',
        senderId: parentUserId,
        body: 'Thank you!',
        at: fixedNow.subtract(const Duration(minutes: 10)),
      ),
    ],
  },
);

IconButton _sendButton(WidgetTester tester) => tester.widget<IconButton>(
  find.widgetWithIcon(IconButton, Icons.arrow_upward),
);

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets(
    'shows both sides with day separators, and marks the conversation read',
    (tester) async {
      final client = _clientWithThread();
      await _pumpChat(tester, client);

      expect(find.text('Rana Haddad'), findsOneWidget);
      expect(find.text('About Amir'), findsOneWidget);
      expect(find.text('Amir did well today'), findsOneWidget);
      expect(find.text('Thank you!'), findsOneWidget);
      expect(find.text('Yesterday'), findsOneWidget);
      expect(find.text('Today'), findsOneWidget);
      expect(client.readCalls, ['conv-1']);

      // Mine trails (right in LTR), theirs leads.
      final width = tester.getSize(find.byType(Scaffold)).width;
      expect(
        tester.getCenter(find.text('Thank you!')).dx,
        greaterThan(width / 2),
      );
      expect(
        tester.getCenter(find.text('Amir did well today')).dx,
        lessThan(width / 2),
      );

      await _dispose(tester);
    },
  );

  testWidgets('RTL mirrors the sides', (tester) async {
    await _pumpChat(tester, _clientWithThread(), locale: const Locale('ar'));

    final width = tester.getSize(find.byType(Scaffold)).width;
    expect(tester.getCenter(find.text('Thank you!')).dx, lessThan(width / 2));
    expect(
      tester.getCenter(find.text('Amir did well today')).dx,
      greaterThan(width / 2),
    );

    await _dispose(tester);
  });

  testWidgets('send is disabled for blank text and sends the trimmed message', (
    tester,
  ) async {
    final client = _clientWithThread();
    await _pumpChat(tester, client);

    expect(_sendButton(tester).onPressed, isNull);
    await tester.enterText(find.byType(TextField), '   ');
    await tester.pump();
    expect(_sendButton(tester).onPressed, isNull);

    await tester.enterText(find.byType(TextField), '  See you at pickup ');
    await tester.pump();
    expect(_sendButton(tester).onPressed, isNotNull);

    await tester.tap(find.byIcon(Icons.arrow_upward));
    await tester.pumpAndSettle();

    expect(client.sentBodies, ['See you at pickup']);
    expect(find.text('See you at pickup'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      isEmpty,
    );

    await _dispose(tester);
  });

  testWidgets('a failed send can be retried by tapping it', (tester) async {
    final client = _clientWithThread()..sendError = StateError('offline');
    await _pumpChat(tester, client);

    await tester.enterText(find.byType(TextField), 'Hello');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.arrow_upward));
    await tester.pumpAndSettle();
    expect(find.text('Not sent. Tap to retry.'), findsOneWidget);

    client.sendError = null;
    await tester.tap(find.text('Hello'));
    await tester.pumpAndSettle();

    expect(find.text('Not sent. Tap to retry.'), findsNothing);
    expect(find.text('Hello'), findsOneWidget);
    expect(client.sentBodies, ['Hello', 'Hello']);

    await _dispose(tester);
  });

  testWidgets(
    'polls every 5s while open; pauses with the app; stops when closed',
    (tester) async {
      final client = _clientWithThread();
      await _pumpChat(tester, client);
      int polls() =>
          client.listMessageCalls.where((call) => call.since != null).length;

      expect(polls(), 0);
      client.messages['conv-1']!.add(
        messageFixture(
          'm3',
          body: 'One more thing',
          at: fixedNow.subtract(const Duration(minutes: 1)),
        ),
      );
      await tester.pump(const Duration(seconds: 5));
      await tester.pump();
      expect(polls(), 1);
      expect(find.text('One more thing'), findsOneWidget);
      // New message from the teacher while open: read again.
      expect(client.readCalls, ['conv-1', 'conv-1']);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump(const Duration(seconds: 30));
      expect(polls(), 1);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(polls(), 2, reason: 'catches up immediately on resume');
      await tester.pump(const Duration(seconds: 5));
      expect(polls(), 3);

      await _dispose(tester);
      await tester.pump(const Duration(seconds: 30));
      expect(polls(), 3);
    },
  );
}
