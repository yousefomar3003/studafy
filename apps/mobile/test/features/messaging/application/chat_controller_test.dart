import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/features/messaging/application/messaging_providers.dart';
import 'package:studafy_mobile/src/features/messaging/domain/chat_state.dart';
import 'package:studafy_mobile/src/features/messaging/domain/messaging.dart';

import '../support.dart';

/// A container whose `chatControllerProvider('conv-1')` is kept alive by a listener, with the
/// first page already loaded.
Future<(ProviderContainer, FakeMessagingClient)> _loaded(
  FakeMessagingClient client,
) async {
  final container = ProviderContainer(
    overrides: [
      messagingClientProvider.overrideWithValue(client),
      messagingUserIdProvider.overrideWithValue(parentUserId),
      chatClockProvider.overrideWithValue(() => fixedNow),
    ],
  );
  addTearDown(container.dispose);
  container.listen(chatControllerProvider('conv-1'), (_, _) {});
  await pumpEventQueue();
  return (container, client);
}

ChatController _controller(ProviderContainer container) =>
    container.read(chatControllerProvider('conv-1').notifier);

ChatState _state(ProviderContainer container) =>
    container.read(chatControllerProvider('conv-1'));

void main() {
  final t0 = fixedNow.subtract(const Duration(hours: 1));

  group('load', () {
    test('fetches the newest page and marks the conversation read', () async {
      final (container, client) = await _loaded(
        FakeMessagingClient(
          messages: {
            'conv-1': [
              messageFixture('m1', at: t0),
              messageFixture('m2', at: t0.add(const Duration(minutes: 1))),
            ],
          },
        ),
      );

      final state = _state(container);
      expect(state.isLoading, isFalse);
      expect(state.messages.map((m) => m.id), ['m1', 'm2']);
      expect(client.listMessageCalls.single.limit, chatPageSize);
      expect(client.readCalls, ['conv-1']);
    });

    test('a failed first page is an error the screen can retry', () async {
      final client = FakeMessagingClient(messages: {'conv-1': []})
        ..listError = StateError('x');
      final (container, _) = await _loaded(client);
      expect(_state(container).error, isNotNull);

      client.listError = null;
      await _controller(container).load();
      expect(_state(container).error, isNull);
      expect(_state(container).isLoading, isFalse);
    });
  });

  group('poll', () {
    test(
      'merges messages newer than the latest without duplicating the overlap',
      () async {
        final latest = t0.add(const Duration(minutes: 1));
        final client = FakeMessagingClient(
          messages: {
            'conv-1': [
              messageFixture('m1', at: t0),
              messageFixture('m2', at: latest),
            ],
          },
        );
        final (container, _) = await _loaded(client);

        client.messages['conv-1']!.add(
          messageFixture('m3', at: latest.add(const Duration(minutes: 1))),
        );
        await _controller(container).poll();

        // The fake answers `since` inclusively, so m2 comes back too — it must not repeat.
        expect(client.listMessageCalls.last.since, latest);
        expect(_state(container).messages.map((m) => m.id), ['m1', 'm2', 'm3']);
        // Something from the other side arrived while open: marked read again.
        expect(client.readCalls, ['conv-1', 'conv-1']);
      },
    );

    test('nothing new: no state change and no extra read', () async {
      final client = FakeMessagingClient(
        messages: {
          'conv-1': [messageFixture('m1', at: t0)],
        },
      );
      final (container, _) = await _loaded(client);
      final before = _state(container);

      await _controller(container).poll();

      expect(identical(_state(container), before), isTrue);
      expect(client.readCalls, ['conv-1']);
    });
  });

  group('polling timer', () {
    testWidgets('ticks every 5 seconds while started, never after stop', (
      tester,
    ) async {
      final client = FakeMessagingClient(
        messages: {
          'conv-1': [messageFixture('m1', at: t0)],
        },
      );
      final container = ProviderContainer(
        overrides: [
          messagingClientProvider.overrideWithValue(client),
          messagingUserIdProvider.overrideWithValue(parentUserId),
        ],
      );
      addTearDown(container.dispose);
      container.listen(chatControllerProvider('conv-1'), (_, _) {});
      await tester.pump();
      final initialCalls = client.listMessageCalls.length;

      final controller = _controller(container)..startPolling();
      expect(controller.isPolling, isTrue);

      await tester.pump(const Duration(seconds: 5));
      await tester.pump(const Duration(seconds: 5));
      expect(client.listMessageCalls.length, initialCalls + 2);
      expect(client.listMessageCalls.last.since, t0);

      controller.stopPolling();
      expect(controller.isPolling, isFalse);
      await tester.pump(const Duration(seconds: 20));
      expect(client.listMessageCalls.length, initialCalls + 2);
    });

    testWidgets('disposing the provider cancels the timer', (tester) async {
      final client = FakeMessagingClient(messages: {'conv-1': []});
      final container = ProviderContainer(
        overrides: [
          messagingClientProvider.overrideWithValue(client),
          messagingUserIdProvider.overrideWithValue(parentUserId),
        ],
      );
      final subscription = container.listen(
        chatControllerProvider('conv-1'),
        (_, _) {},
      );
      await tester.pump();
      final controller = _controller(container)..startPolling();
      final calls = client.listMessageCalls.length;

      subscription.close();
      container.dispose();
      expect(controller.isPolling, isFalse);
      await tester.pump(const Duration(seconds: 15));
      expect(client.listMessageCalls.length, calls);
    });
  });

  group('send', () {
    test('shows the message at once, then swaps in the server copy', () async {
      final client = FakeMessagingClient(messages: {'conv-1': []})
        ..sendGate = Completer<void>();
      final (container, _) = await _loaded(client);

      final sending = _controller(container).send('  Hello there  ');
      await pumpEventQueue();

      var state = _state(container);
      expect(state.pending.single.body, 'Hello there');
      expect(state.pending.single.status, PendingStatus.sending);
      expect(state.messages, isEmpty);

      client.sendGate!.complete();
      await sending;

      state = _state(container);
      expect(state.pending, isEmpty);
      expect(state.messages.single.body, 'Hello there');
      expect(client.sentBodies, ['Hello there']);
    });

    test('a failed send stays as failed and retry delivers it', () async {
      final client = FakeMessagingClient(messages: {'conv-1': []})
        ..sendError = StateError('down');
      final (container, _) = await _loaded(client);

      await _controller(container).send('Hello');
      final failed = _state(container).pending.single;
      expect(failed.status, PendingStatus.failed);
      expect(failed.failure, PendingFailure.other);

      client.sendError = null;
      await _controller(container).retry(failed.localId);

      expect(_state(container).pending, isEmpty);
      expect(_state(container).messages.single.body, 'Hello');
      expect(client.sentBodies, ['Hello', 'Hello']);
    });

    test(
      'the send rate limit (429) fails distinctly, so the bubble can say to wait',
      () async {
        final client = FakeMessagingClient(messages: {'conv-1': []})
          ..sendError = DioException(
            requestOptions: RequestOptions(path: '/x'),
            response: Response(
              requestOptions: RequestOptions(path: '/x'),
              statusCode: 429,
            ),
            error: const ApiException(status: 429, title: 'Too Many Requests'),
          );
        final (container, _) = await _loaded(client);

        await _controller(container).send('Hello');

        final pending = _state(container).pending.single;
        expect(pending.status, PendingStatus.failed);
        expect(pending.failure, PendingFailure.rateLimited);
      },
    );

    test('blank or over-long text is ignored', () async {
      final client = FakeMessagingClient(messages: {'conv-1': []});
      final (container, _) = await _loaded(client);

      await _controller(container).send('   \n ');
      await _controller(container).send('x' * 2001);

      expect(_state(container).pending, isEmpty);
      expect(client.sentBodies, isEmpty);
    });

    test(
      'a poll that sees the sent message first does not show it twice',
      () async {
        final client = FakeMessagingClient(
          messages: {
            'conv-1': [messageFixture('m1', at: t0)],
          },
        )..sendGate = Completer<void>();
        final (container, _) = await _loaded(client);

        final sending = _controller(container).send('Hi');
        await pumpEventQueue();
        // The server stored it (another device, or the POST is slow to answer) — the poll sees it.
        client.messages['conv-1']!.add(
          messageFixture(
            'srv-0',
            senderId: parentUserId,
            body: 'Hi',
            at: fixedNow,
          ),
        );
        await _controller(container).poll();

        expect(_state(container).pending, isEmpty);
        expect(_state(container).messages.map((m) => m.body), [
          'Message m1',
          'Hi',
        ]);

        // The POST then answers with that same stored message: it collapses into the one shown.
        client.sendGate!.complete();
        await sending;
        expect(_state(container).pending, isEmpty);
        expect(_state(container).messages.map((m) => m.id), ['m1', 'srv-0']);
      },
    );
  });

  group('loadOlder', () {
    test(
      'pages backwards from the oldest shown message and prepends',
      () async {
        final all = [
          for (var i = 0; i < chatPageSize + 5; i++)
            messageFixture('m$i', at: t0.add(Duration(minutes: i))),
        ];
        final client = FakeMessagingClient(messages: {'conv-1': all});
        final (container, _) = await _loaded(client);
        expect(_state(container).hasMore, isTrue);
        expect(_state(container).messages.first.id, 'm5');

        await _controller(container).loadOlder();

        expect(client.listMessageCalls.last.before, 'm5');
        final state = _state(container);
        expect(state.messages.length, chatPageSize + 5);
        expect(state.messages.first.id, 'm0');
        expect(state.hasMore, isFalse);
      },
    );
  });

  group('images', () {
    const images = [
      PendingImage(localPath: '/tmp/a.jpg', storageKey: 'key-a'),
      PendingImage(localPath: '/tmp/b.jpg', storageKey: 'key-b'),
    ];

    test(
      'sends the storage keys with the text; the pending bubble carries the local files',
      () async {
        final client = FakeMessagingClient(messages: {'conv-1': []})
          ..sendGate = Completer<void>();
        final (container, _) = await _loaded(client);

        final sending = _controller(container).send('Look', images: images);
        await pumpEventQueue();
        final pending = _state(container).pending.single;
        expect(pending.status, PendingStatus.sending);
        expect(pending.images.map((i) => i.localPath), [
          '/tmp/a.jpg',
          '/tmp/b.jpg',
        ]);

        client.sendGate!.complete();
        await sending;
        expect(client.sentStorageKeys.single, ['key-a', 'key-b']);
        expect(_state(container).pending, isEmpty);
        expect(_state(container).messages.single.attachments, hasLength(2));
      },
    );

    test('an image-only message sends an empty body', () async {
      final client = FakeMessagingClient(messages: {'conv-1': []});
      final (container, _) = await _loaded(client);

      await _controller(container).send('  ', images: images.sublist(0, 1));

      expect(client.sentBodies, ['']);
      expect(client.sentStorageKeys.single, ['key-a']);
    });

    test('more than four images are refused client-side', () async {
      final client = FakeMessagingClient(messages: {'conv-1': []});
      final (container, _) = await _loaded(client);

      await _controller(
        container,
      ).send('x', images: [...images, ...images, images.first]);

      expect(client.sentBodies, isEmpty);
    });

    test('retry re-sends the same storage keys', () async {
      final client = FakeMessagingClient(messages: {'conv-1': []})
        ..sendError = apiError(503, 'STORAGE_NOT_CONFIGURED');
      final (container, _) = await _loaded(client);

      await _controller(container).send('', images: images);
      final failed = _state(container).pending.single;
      expect(failed.failure, PendingFailure.storageUnavailable);
      expect(failed.images, hasLength(2));

      client.sendError = null;
      await _controller(container).retry(failed.localId);

      expect(client.sentStorageKeys, [
        ['key-a', 'key-b'],
        ['key-a', 'key-b'],
      ]);
      expect(_state(container).pending, isEmpty);
    });

    test('storage and validation errors map to their own failures', () async {
      final client = FakeMessagingClient(messages: {'conv-1': []});
      final (container, _) = await _loaded(client);

      client.sendError = apiError(402, 'STORAGE_QUOTA_EXCEEDED');
      await _controller(container).send('a', images: images);
      client.sendError = apiError(400, 'VALIDATION_FAILED');
      await _controller(container).send('b', images: images);

      expect(_state(container).pending.map((p) => p.failure), [
        PendingFailure.quotaExceeded,
        PendingFailure.invalid,
      ]);
    });

    test(
      'refreshAttachments re-fetches the loaded messages for fresh URLs, throttled',
      () async {
        final client = FakeMessagingClient(
          messages: {
            'conv-1': [
              messageFixture(
                'm1',
                at: t0,
                attachments: [attachmentFixture('a1', url: 'https://old')],
              ),
            ],
          },
        );
        final (container, _) = await _loaded(client);
        client.messages['conv-1'] = [
          messageFixture(
            'm1',
            at: t0,
            attachments: [attachmentFixture('a1', url: 'https://new')],
          ),
        ];
        final callsBefore = client.listMessageCalls.length;

        await _controller(container).refreshAttachments();
        expect(
          _state(container).messages.single.attachments.single.downloadUrl,
          'https://new',
        );
        expect(client.listMessageCalls.length, callsBefore + 1);
        expect(client.listMessageCalls.last.since, isNull);
        expect(client.listMessageCalls.last.before, isNull);

        // Inside the cooldown (the clock is fixed): no second fetch.
        await _controller(container).refreshAttachments();
        expect(client.listMessageCalls.length, callsBefore + 1);
      },
    );
  });

  group('blocking', () {
    test('MESSAGING_BLOCKED on send switches to "they blocked me"', () async {
      final client = FakeMessagingClient(
        conversations: [conversationFixture(hasBlockedMe: true)],
        messages: {'conv-1': []},
      )..sendError = apiError(403, 'MESSAGING_BLOCKED');
      final (container, _) = await _loaded(client);
      expect(_state(container).block, isNull);

      await _controller(container).send('Hello');
      await pumpEventQueue();

      expect(_state(container).pending.single.failure, PendingFailure.blocked);
      expect(
        _state(container).block,
        const BlockState(blockedByMe: false, hasBlockedMe: true),
      );
    });

    test('block / unblock call the API and update the state', () async {
      final client = FakeMessagingClient(messages: {'conv-1': []});
      final (container, _) = await _loaded(client);
      _controller(container).seedBlock(BlockState.none);

      await _controller(container).block();
      expect(client.blockCalls, ['conv-1']);
      expect(_state(container).block!.blockedByMe, isTrue);

      await _controller(container).unblock();
      expect(client.unblockCalls, ['conv-1']);
      expect(_state(container).block, BlockState.none);
    });

    test('a failed block throws and leaves the state alone', () async {
      final client = FakeMessagingClient(messages: {'conv-1': []})
        ..blockError = StateError('x');
      final (container, _) = await _loaded(client);
      _controller(container).seedBlock(BlockState.none);

      await expectLater(_controller(container).block(), throwsStateError);
      expect(_state(container).block, BlockState.none);
    });

    test(
      'seedBlock does not overwrite flags the chat already learned',
      () async {
        final client = FakeMessagingClient(messages: {'conv-1': []});
        final (container, _) = await _loaded(client);

        _controller(container).applyBlockState(
          const BlockState(blockedByMe: true, hasBlockedMe: false),
        );
        _controller(container).seedBlock(BlockState.none);

        expect(_state(container).block!.blockedByMe, isTrue);
      },
    );
  });
}
