import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/realtime/protocol.dart';
import 'package:studafy_mobile/src/core/realtime/realtime_client.dart';

import 'fake_realtime_socket.dart';

class FakeAppLifecycleObserver implements AppLifecycleObserver {
  FakeAppLifecycleObserver(this.onResume, this.onPause);

  final void Function() onResume;
  final void Function() onPause;
  bool disposed = false;

  @override
  void dispose() => disposed = true;
}

Future<void> settle() => Future<void>.delayed(Duration.zero);

void main() {
  late FakeRealtimeSocketFactory socketFactory;
  late FakeTimerScheduler timerScheduler;
  late FakeAppLifecycleObserver? lifecycleObserver;
  late List<RealtimeConnectionStatus> statuses;

  RealtimeClient buildClient({
    RealtimeTokenProvider? getToken,
    int maxConnectFailures = 3,
  }) {
    lifecycleObserver = null;
    final client = RealtimeClient(
      baseUrl: Uri.parse('ws://10.0.2.2:3001'),
      getToken: getToken ?? (() async => 'token-1'),
      socketFactory: socketFactory.call,
      createTimer: timerScheduler.call,
      random: () => 0.5, // no jitter
      maxConnectFailures: maxConnectFailures,
      lifecycleObserverFactory: ({required onResume, required onPause}) {
        return lifecycleObserver = FakeAppLifecycleObserver(onResume, onPause);
      },
    );
    statuses = [];
    client.statusStream.listen(statuses.add);
    return client;
  }

  setUp(() {
    socketFactory = FakeRealtimeSocketFactory();
    timerScheduler = FakeTimerScheduler();
  });

  test(
    'with no token, reports unauthorized and never opens a socket',
    () async {
      final client = buildClient(getToken: () async => null);
      client.connect();
      await settle();

      expect(client.status, RealtimeConnectionStatus.unauthorized);
      expect(socketFactory.created, isEmpty);
    },
  );

  test(
    'opens a socket with the token in the query string and connects',
    () async {
      final client = buildClient();
      client.connect();
      await settle();

      expect(socketFactory.created, hasLength(1));
      expect(
        socketFactory.created.single.url.queryParameters['token'],
        'token-1',
      );
      expect(socketFactory.created.single.url.path, '/ws');
      expect(client.status, RealtimeConnectionStatus.connecting);

      socketFactory.created.single.completeReady();
      await settle();

      expect(client.status, RealtimeConnectionStatus.connected);
      expect(statuses, [
        RealtimeConnectionStatus.connecting,
        RealtimeConnectionStatus.connected,
      ]);
    },
  );

  test('swaps http(s) scheme for ws(s) when building the socket url', () async {
    final client = RealtimeClient(
      baseUrl: Uri.parse('https://api.studafy.com'),
      getToken: () async => 'token-1',
      socketFactory: socketFactory.call,
      createTimer: timerScheduler.call,
    );
    client.connect();
    await settle();

    expect(socketFactory.created.single.url.scheme, 'wss');
  });

  test('delivers a validly-parsed domain event on the events stream', () async {
    final client = buildClient();
    final events = <EventEnvelope>[];
    client.events.listen(events.add);
    client.connect();
    await settle();
    socketFactory.created.single.completeReady();
    await settle();

    socketFactory.created.single.emitMessage(
      jsonEncode({
        'id': '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        'type': 'grades.published',
        'room': 'school:123:role:STUDENT',
        'payload': {'a': 1},
        'publishedAt': '2026-07-09T12:00:00.000Z',
      }),
    );
    await settle();

    expect(events, hasLength(1));
    expect(events.single.type, 'grades.published');
  });

  test('dedups an event id seen twice', () async {
    final client = buildClient();
    final events = <EventEnvelope>[];
    client.events.listen(events.add);
    client.connect();
    await settle();
    socketFactory.created.single.completeReady();
    await settle();

    final frame = jsonEncode({
      'id': '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      'type': 'grades.published',
      'room': 'school:123:role:STUDENT',
      'payload': null,
      'publishedAt': '2026-07-09T12:00:00.000Z',
    });
    socketFactory.created.single
      ..emitMessage(frame)
      ..emitMessage(frame);
    await settle();

    expect(events, hasLength(1));
  });

  test('drops a malformed frame without emitting or crashing', () async {
    final client = buildClient();
    final events = <EventEnvelope>[];
    client.events.listen(events.add);
    client.connect();
    await settle();
    socketFactory.created.single.completeReady();
    await settle();

    socketFactory.created.single.emitMessage('not json');
    await settle();

    expect(events, isEmpty);
    expect(client.status, RealtimeConnectionStatus.connected);
  });

  test(
    'join sends immediately once connected, and is resent after a reconnect',
    () async {
      final client = buildClient();
      client.connect();
      await settle();
      socketFactory.created.single.completeReady();
      await settle();

      client.join('school:123:role:INSTRUCTOR');
      expect(socketFactory.created.single.sentMessages, [
        jsonEncode({'type': 'join', 'room': 'school:123:role:INSTRUCTOR'}),
      ]);

      // Connection drops; once ever connected, a reconnect is scheduled with backoff.
      socketFactory.created.single.emitClose(code: 1006);
      await settle();
      expect(client.status, RealtimeConnectionStatus.reconnecting);
      expect(timerScheduler.scheduled, hasLength(1));

      timerScheduler.latest.fire();
      await settle();
      expect(socketFactory.created, hasLength(2));
      socketFactory.created.last.completeReady();
      await settle();

      expect(client.status, RealtimeConnectionStatus.connected);
      expect(socketFactory.created.last.sentMessages, [
        jsonEncode({'type': 'join', 'room': 'school:123:role:INSTRUCTOR'}),
      ]);
    },
  );

  test(
    'reconnects immediately (zero delay) on the reauth-required close code',
    () async {
      final client = buildClient();
      client.connect();
      await settle();
      socketFactory.created.single.completeReady();
      await settle();

      socketFactory.created.single.emitClose(code: reauthRequiredCloseCode);
      await settle();

      expect(timerScheduler.scheduled, hasLength(1));
      expect(timerScheduler.scheduled.single.duration, Duration.zero);
    },
  );

  test(
    'gives up after maxConnectFailures consecutive pre-open failures',
    () async {
      final client = buildClient(maxConnectFailures: 2);
      client.connect();
      await settle();
      socketFactory.created[0].failReady();
      await settle();
      expect(client.status, RealtimeConnectionStatus.reconnecting);

      timerScheduler.latest.fire();
      await settle();
      socketFactory.created[1].failReady();
      await settle();

      expect(client.status, RealtimeConnectionStatus.unauthorized);
      expect(socketFactory.created, hasLength(2));
    },
  );

  test(
    'disconnect stops retrying and a late close from the superseded socket is ignored',
    () async {
      final client = buildClient();
      client.connect();
      await settle();
      final firstSocket = socketFactory.created.single;
      firstSocket.completeReady();
      await settle();

      client.disconnect();
      expect(client.status, RealtimeConnectionStatus.idle);
      expect(firstSocket.closeRequested, isTrue);

      // The now-superseded socket's close arrives after disconnect() already tore it down.
      firstSocket.emitClose(code: 1006);
      await settle();

      expect(client.status, RealtimeConnectionStatus.idle);
      expect(timerScheduler.scheduled, isEmpty);
    },
  );

  test(
    'backgrounding tears the socket down; foreground resume reconnects and reconciles',
    () async {
      final client = buildClient();
      client.connect();
      await settle();
      socketFactory.created.single.completeReady();
      await settle();
      expect(client.status, RealtimeConnectionStatus.connected);

      lifecycleObserver!.onPause();
      await settle();

      expect(client.status, RealtimeConnectionStatus.idle);
      expect(socketFactory.created.single.closeRequested, isTrue);
      // Backgrounding must not itself schedule a reconnect timer — resume drives it.
      expect(timerScheduler.scheduled, isEmpty);

      lifecycleObserver!.onResume();
      await settle();

      expect(socketFactory.created, hasLength(2));
      socketFactory.created.last.completeReady();
      await settle();

      // Status went connected -> idle -> connected: a feature watching statusStream can treat this
      // transition as "reconcile", exactly like a network-drop reconnect.
      expect(statuses, [
        RealtimeConnectionStatus.connecting,
        RealtimeConnectionStatus.connected,
        RealtimeConnectionStatus.idle,
        RealtimeConnectionStatus.connecting,
        RealtimeConnectionStatus.connected,
      ]);
    },
  );

  test(
    'dispose stops the client and releases the lifecycle observer',
    () async {
      final client = buildClient();
      client.connect();
      await settle();
      socketFactory.created.single.completeReady();
      await settle();

      client.dispose();

      expect(client.status, RealtimeConnectionStatus.idle);
      expect(lifecycleObserver!.disposed, isTrue);
    },
  );
}
