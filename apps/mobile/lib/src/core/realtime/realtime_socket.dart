import 'dart:async';

import 'package:web_socket_channel/web_socket_channel.dart';

/// Info the socket reports when a connection ends, whether it opened first or not. [code] mirrors
/// the WebSocket close code when the platform channel exposes one (it doesn't for a handshake
/// that never opened, e.g. a refused token).
class RealtimeSocketClose {
  const RealtimeSocketClose({this.code});
  final int? code;
}

/// Minimal socket transport surface the client talks to. The default implementation
/// ([WebSocketChannelSocket]) wraps `package:web_socket_channel`; tests inject a fake so reconnect
/// behavior can be driven without a live server. Adapted from the callback-based `RealtimeSocket`
/// in `apps/web/src/lib/realtime/client.ts` to Dart's `Future`/`Stream` idioms — there's no
/// separate open/error/close event trio here because `web_socket_channel` doesn't expose one:
/// [ready] stands in for a successful open (or the handshake's rejection), and [closed] is the
/// single, always-eventually-completing signal for how the connection ended, matching the web
/// client's "the close handler owns recovery" behavior.
abstract interface class RealtimeSocket {
  /// Completes once the handshake succeeds. Completes with an error if the gateway rejects it (or
  /// the socket never connects) — inspect [closed] for the close code, not this error, since the
  /// browser/io WebSocket APIs don't reliably surface the rejection reason here.
  Future<void> get ready;

  /// Text frames received after a successful [ready].
  Stream<String> get messages;

  /// Completes exactly once, when the connection ends for any reason — after a successful open,
  /// or instead of ever opening.
  Future<RealtimeSocketClose> get closed;

  void send(String data);

  Future<void> close();
}

/// Factory seam for [RealtimeSocket], analogous to the web client's `socketFactory` option.
typedef RealtimeSocketFactory = RealtimeSocket Function(Uri url);

/// Default [RealtimeSocketFactory]: wraps `WebSocketChannel.connect`, which works unmodified on
/// both io (mobile/desktop) and web platforms.
RealtimeSocket createWebSocketChannelSocket(Uri url) =>
    WebSocketChannelSocket(url);

class WebSocketChannelSocket implements RealtimeSocket {
  WebSocketChannelSocket(Uri url) : _channel = WebSocketChannel.connect(url) {
    _channel.ready
        .then((_) {
          if (!_readyCompleter.isCompleted) {
            _readyCompleter.complete();
          }
        })
        .catchError((Object error) {
          if (!_readyCompleter.isCompleted) {
            _readyCompleter.completeError(error);
          }
          _completeClosed();
        });

    _channel.stream.listen(
      (Object? data) {
        if (data is String) {
          _messages.add(data);
        }
      },
      onDone: _completeClosed,
      // The `ready` handler above owns reporting a failed handshake; a mid-connection stream
      // error is always followed by `onDone`, which is what drives reconnect recovery.
      onError: (_) {},
      cancelOnError: false,
    );
  }

  final WebSocketChannel _channel;
  final _messages = StreamController<String>.broadcast();
  final _readyCompleter = Completer<void>();
  final _closedCompleter = Completer<RealtimeSocketClose>();

  void _completeClosed() {
    if (!_closedCompleter.isCompleted) {
      _closedCompleter.complete(RealtimeSocketClose(code: _channel.closeCode));
    }
  }

  @override
  Future<void> get ready => _readyCompleter.future;

  @override
  Stream<String> get messages => _messages.stream;

  @override
  Future<RealtimeSocketClose> get closed => _closedCompleter.future;

  @override
  void send(String data) => _channel.sink.add(data);

  @override
  Future<void> close() => _channel.sink.close();
}
