import 'dart:async';

import 'package:studafy_mobile/src/core/realtime/realtime_socket.dart';

/// Deterministic [RealtimeSocket] test double: nothing resolves until the test calls one of the
/// `complete*`/`emit*` methods.
class FakeRealtimeSocket implements RealtimeSocket {
  FakeRealtimeSocket(this.url);

  final Uri url;
  final sentMessages = <String>[];
  bool closeRequested = false;

  final _messages = StreamController<String>.broadcast();
  final _readyCompleter = Completer<void>();
  final _closedCompleter = Completer<RealtimeSocketClose>();

  @override
  Future<void> get ready => _readyCompleter.future;

  @override
  Stream<String> get messages => _messages.stream;

  @override
  Future<RealtimeSocketClose> get closed => _closedCompleter.future;

  @override
  void send(String data) => sentMessages.add(data);

  @override
  Future<void> close() async {
    closeRequested = true;
    emitClose();
  }

  void completeReady() => _readyCompleter.complete();

  void failReady([int? code]) {
    if (!_readyCompleter.isCompleted) {
      _readyCompleter.completeError(StateError('handshake refused'));
    }
    emitClose(code: code);
  }

  void emitMessage(String data) => _messages.add(data);

  void emitClose({int? code}) {
    if (!_closedCompleter.isCompleted) {
      _closedCompleter.complete(RealtimeSocketClose(code: code));
    }
  }
}

/// Records every socket a [FakeRealtimeSocket] factory created, in creation order, so a test can
/// drive each connection attempt in turn.
class FakeRealtimeSocketFactory {
  final created = <FakeRealtimeSocket>[];

  RealtimeSocket call(Uri url) {
    final socket = FakeRealtimeSocket(url);
    created.add(socket);
    return socket;
  }
}

/// A [Timer] double that never actually schedules anything; the test decides when [callback]
/// fires by calling [fire] directly.
class FakeTimer implements Timer {
  FakeTimer(this.duration, this.callback);

  final Duration duration;
  final void Function() callback;
  bool cancelled = false;

  void fire() {
    if (!cancelled) {
      callback();
    }
  }

  @override
  void cancel() => cancelled = true;

  @override
  bool get isActive => !cancelled;

  @override
  int get tick => 0;
}

/// Records every [FakeTimer] a `createTimer` seam created, so a test can inspect the scheduled
/// delay and fire it manually instead of waiting on a real one.
class FakeTimerScheduler {
  final scheduled = <FakeTimer>[];

  Timer call(Duration duration, void Function() callback) {
    final timer = FakeTimer(duration, callback);
    scheduled.add(timer);
    return timer;
  }

  /// The most recently scheduled, still-active timer.
  FakeTimer get latest => scheduled.lastWhere((timer) => !timer.cancelled);
}
