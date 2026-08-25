import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/widgets.dart';

import 'backoff.dart';
import 'protocol.dart';
import 'realtime_socket.dart';

/// Connection state surfaced to the UI. Mirrors
/// `apps/web/src/lib/realtime/client.ts`'s `RealtimeConnectionStatus`.
/// - [idle] — never started, intentionally disconnected, or backgrounded (see [RealtimeClient]'s
///   app-lifecycle handling).
/// - [connecting] — handshake in progress.
/// - [connected] — socket open and joined to the home rooms.
/// - [reconnecting] — socket down; waiting out a jittered backoff before retrying.
/// - [unauthorized] — no session token, or the handshake was rejected repeatedly; not retrying.
enum RealtimeConnectionStatus {
  idle,
  connecting,
  connected,
  reconnecting,
  unauthorized,
}

/// Resolves the handshake token on every connect attempt, and again on a re-auth close. Reuses
/// the API client's [TokenProvider] shape (`core/api/auth_interceptor.dart`) — same contract,
/// same "no session/auth feature exists yet" seam.
typedef RealtimeTokenProvider = Future<String?> Function();

const int _defaultMaxConnectFailures = 3;
const int _maxSeenEventIds = 128;

/// What [RealtimeClient] tears down when it stops observing app-lifecycle transitions.
abstract interface class AppLifecycleObserver {
  void dispose();
}

/// Factory seam for [AppLifecycleObserver], analogous to [RealtimeSocketFactory] — the default
/// wraps a real [AppLifecycleListener]; tests inject a fake that lets them call `onResume`/
/// `onPause` directly instead of driving the platform lifecycle channel.
typedef AppLifecycleObserverFactory =
    AppLifecycleObserver Function({
      required void Function() onResume,
      required void Function() onPause,
    });

class _RealAppLifecycleObserver implements AppLifecycleObserver {
  _RealAppLifecycleObserver({
    required void Function() onResume,
    required void Function() onPause,
  }) : _listener = AppLifecycleListener(onResume: onResume, onPause: onPause);

  final AppLifecycleListener _listener;

  @override
  void dispose() => _listener.dispose();
}

AppLifecycleObserver _createAppLifecycleListener({
  required void Function() onResume,
  required void Function() onPause,
}) => _RealAppLifecycleObserver(onResume: onResume, onPause: onPause);

/// The app-wide realtime socket client: a single connection to the gateway (`apps/realtime`) that
/// authenticates with the [getToken] seam, rejoins subscribed rooms after every reconnect, and
/// exposes connection status and live domain events as streams for Riverpod to build providers on
/// (`realtime_providers.dart`). Framework-agnostic apart from its use of [AppLifecycleObserver] for
/// background/foreground handling — ported from `apps/web/src/lib/realtime/client.ts`, adapted
/// from browser `online`/`offline` events to Flutter app-lifecycle events.
///
/// Reconciliation after a gap (a reconnect, or a resume-from-background) is deliberately *not*
/// this class's job: unlike the web client, which owns a TanStack Query invalidation map, this
/// client only tells consumers *that* the connection came back via [statusStream] — a transition
/// into [RealtimeConnectionStatus.connected] from anything other than freshly-idle. Each feature's
/// own provider decides what "possibly stale" means for its own data and invalidates itself; see
/// `realtime_providers.dart`'s doc comment for the exact pattern.
class RealtimeClient {
  RealtimeClient({
    required this.baseUrl,
    required this.getToken,
    RealtimeSocketFactory? socketFactory,
    RealtimeBackoff backoff = const RealtimeBackoff(),
    Timer Function(Duration, void Function())? createTimer,
    double Function()? random,
    int maxConnectFailures = _defaultMaxConnectFailures,
    AppLifecycleObserverFactory? lifecycleObserverFactory,
  }) : _socketFactory = socketFactory ?? createWebSocketChannelSocket,
       _backoff = backoff,
       _createTimer = createTimer ?? Timer.new,
       _random = random ?? Random().nextDouble,
       _maxConnectFailures = maxConnectFailures {
    _lifecycleObserver =
        (lifecycleObserverFactory ?? _createAppLifecycleListener)(
          onResume: _handleForeground,
          onPause: _handleBackground,
        );
  }

  /// Gateway origin, e.g. `ws://10.0.2.2:3001` (the `/ws?token=` path is appended).
  final Uri baseUrl;
  final RealtimeTokenProvider getToken;

  final RealtimeSocketFactory _socketFactory;
  final RealtimeBackoff _backoff;
  final Timer Function(Duration, void Function()) _createTimer;
  final double Function() _random;
  final int _maxConnectFailures;

  late final AppLifecycleObserver _lifecycleObserver;

  final _statusController =
      StreamController<RealtimeConnectionStatus>.broadcast();
  final _eventsController = StreamController<EventEnvelope>.broadcast();

  RealtimeConnectionStatus _status = RealtimeConnectionStatus.idle;
  bool _started = false;
  bool _backgrounded = false;
  int _generation = 0;
  RealtimeSocket? _socket;
  bool _socketOpen = false;
  Timer? _reconnectTimer;
  int _connectAttempt = 0;
  int _consecutiveFailures = 0;
  bool _everConnected = false;
  final _joinedRooms = <RoomKey>{};
  final _seenEventIds = <String>[];

  RealtimeConnectionStatus get status => _status;

  /// Connection status changes. Does not replay the current value on subscribe — read [status]
  /// for a synchronous snapshot (this is what `realtime_providers.dart`'s notifier does).
  Stream<RealtimeConnectionStatus> get statusStream => _statusController.stream;

  /// Validated, deduplicated domain events as they arrive. Malformed frames and system
  /// acks/errors are handled internally and never reach this stream.
  Stream<EventEnvelope> get events => _eventsController.stream;

  /// Opens the connection (idempotent).
  void connect() {
    if (!_started) {
      _started = true;
      _connectAttempt = 0;
    }
    unawaited(_attemptConnect());
  }

  /// Closes the connection and stops retrying.
  void disconnect() {
    _started = false;
    _generation += 1;
    _cancelReconnectTimer();
    _teardownSocket();
    _setStatus(RealtimeConnectionStatus.idle);
  }

  /// Subscribes to an additional room (within the caller's own school — the gateway enforces it).
  void join(RoomKey room) {
    if (_joinedRooms.add(room)) {
      _sendClientMessage(JoinRoomMessage(room));
    }
  }

  /// Leaves a room joined via [join]. Home rooms are the gateway's to manage.
  void leave(RoomKey room) {
    if (_joinedRooms.remove(room)) {
      _sendClientMessage(LeaveRoomMessage(room));
    }
  }

  /// Stops the client and releases the app-lifecycle observer. Call once, when the owning scope
  /// (typically a Riverpod provider's `ref.onDispose`) goes away.
  void dispose() {
    disconnect();
    _lifecycleObserver.dispose();
    unawaited(_statusController.close());
    unawaited(_eventsController.close());
  }

  Future<void> _attemptConnect() async {
    if (!_started ||
        _backgrounded ||
        _status == RealtimeConnectionStatus.connecting ||
        _status == RealtimeConnectionStatus.connected) {
      return;
    }
    _cancelReconnectTimer();
    _setStatus(RealtimeConnectionStatus.connecting);

    final generation = _generation;
    final token = await getToken();
    if (!_started || generation != _generation) {
      return;
    }
    if (token == null) {
      _setStatus(RealtimeConnectionStatus.unauthorized);
      return;
    }
    _openSocket(_buildSocketUrl(token));
  }

  Uri _buildSocketUrl(String token) {
    final scheme = switch (baseUrl.scheme) {
      'http' => 'ws',
      'https' => 'wss',
      final other => other,
    };
    return baseUrl.replace(
      scheme: scheme,
      path: '/ws',
      queryParameters: {'token': token},
    );
  }

  void _openSocket(Uri url) {
    final socket = _socketFactory(url);
    _socket = socket;
    socket.ready.then((_) => _handleOpen(socket)).catchError((_) {});
    socket.messages.listen(_handleMessage, onError: (_) {});
    socket.closed.then((info) => _handleClose(socket, info.code));
  }

  void _handleOpen(RealtimeSocket socket) {
    if (!identical(_socket, socket)) {
      // Superseded (disconnected, backgrounded, or a newer attempt) before this one finished
      // opening — nothing to do.
      return;
    }
    _socketOpen = true;
    _consecutiveFailures = 0;
    _everConnected = true;
    _setStatus(RealtimeConnectionStatus.connected);
    _resubscribeRooms();
  }

  void _handleMessage(String data) {
    final incoming = parseIncomingMessage(data);
    if (incoming == null) {
      debugPrint('[realtime] dropped malformed frame: $data');
      return;
    }
    switch (incoming) {
      case SystemErrorMessage(:final message):
        debugPrint('[realtime] gateway error: $message');
      case SystemLeft(:final room):
        _joinedRooms.remove(room);
      case SystemJoined():
      case SystemReauthRequired():
        break;
      case EventEnvelope():
        _applyEvent(incoming);
    }
  }

  void _handleClose(RealtimeSocket socket, int? code) {
    if (!identical(_socket, socket)) {
      // Already superseded — e.g. `_handleBackground` tore this socket down deliberately, or a
      // newer attempt has since replaced it. That path owns whatever happens next.
      return;
    }
    _teardownSocket();
    if (!_started) {
      _setStatus(RealtimeConnectionStatus.idle);
      return;
    }

    if (code == reauthRequiredCloseCode) {
      // Token expired mid-connection: fetch a fresh token and reconnect right away.
      _setStatus(RealtimeConnectionStatus.reconnecting);
      _scheduleReconnect(Duration.zero);
      return;
    }

    _setStatus(RealtimeConnectionStatus.reconnecting);
    if (_everConnected) {
      _scheduleReconnect(_backoffDelay(_connectAttempt++));
      return;
    }

    // Never opened: a pre-open close is either a refused token or a dead network (neither
    // io.WebSocket nor html WebSocket reliably surface the 401 body). Retry with backoff, but
    // give up after a bounded number of consecutive failures so a rejected token doesn't hammer
    // the gateway forever.
    _consecutiveFailures += 1;
    if (_consecutiveFailures >= _maxConnectFailures) {
      _setStatus(RealtimeConnectionStatus.unauthorized);
      return;
    }
    _scheduleReconnect(_backoffDelay(_connectAttempt++));
  }

  void _applyEvent(EventEnvelope envelope) {
    if (_seenEventIds.contains(envelope.id)) {
      return;
    }
    _seenEventIds.add(envelope.id);
    if (_seenEventIds.length > _maxSeenEventIds) {
      _seenEventIds.removeAt(0);
    }
    if (!_eventsController.isClosed) {
      _eventsController.add(envelope);
    }
  }

  void _resubscribeRooms() {
    for (final room in _joinedRooms) {
      _sendClientMessage(JoinRoomMessage(room));
    }
  }

  void _sendClientMessage(ClientMessage message) {
    if (_socketOpen) {
      _socket?.send(jsonEncode(message.toJson()));
    }
  }

  void _scheduleReconnect(Duration delay) {
    if (!_started) {
      return;
    }
    _cancelReconnectTimer();
    _reconnectTimer = _createTimer(delay, () {
      _reconnectTimer = null;
      unawaited(_attemptConnect());
    });
  }

  void _cancelReconnectTimer() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
  }

  void _teardownSocket() {
    _socketOpen = false;
    final socket = _socket;
    _socket = null;
    if (socket != null) {
      unawaited(socket.close());
    }
  }

  Duration _backoffDelay(int attempt) => _backoff.delayFor(attempt, _random);

  void _setStatus(RealtimeConnectionStatus status) {
    if (_status == status) {
      return;
    }
    _status = status;
    if (!_statusController.isClosed) {
      _statusController.add(status);
    }
  }

  void _handleBackground() {
    if (!_started || _backgrounded) {
      return;
    }
    _backgrounded = true;
    _cancelReconnectTimer();
    _teardownSocket();
    _setStatus(RealtimeConnectionStatus.idle);
  }

  void _handleForeground() {
    if (!_started || !_backgrounded) {
      return;
    }
    _backgrounded = false;
    unawaited(_attemptConnect());
  }
}
