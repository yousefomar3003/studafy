import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../di/app_providers.dart';
import 'protocol.dart';
import 'realtime_client.dart';

/// Supplies the realtime handshake token for the active session. Reuses the API client's
/// [TokenProvider] shape (`core/api/auth_interceptor.dart`'s `TokenProvider` typedef — see
/// `RealtimeTokenProvider`'s doc comment for why this isn't just that same type re-exported).
///
/// No session/auth feature exists in this app yet, so this resolves no token: [realtimeClientProvider]
/// stays [RealtimeConnectionStatus.unauthorized], same as being signed out. Override this provider
/// once a session store exists, e.g. `realtimeTokenProvider.overrideWithValue(() => session.getToken())`
/// at app bootstrap — mirrors how `appConfigProvider` is overridden today.
final realtimeTokenProvider = Provider<RealtimeTokenProvider>((ref) {
  return () async => null;
});

/// The app-wide [RealtimeClient]. A plain (non-autoDispose) provider, so it is constructed once
/// and lives for the app's lifetime — same pattern as [networkConfigProvider] and [routerProvider].
/// Connects as soon as it is first read; `ref.onDispose` tears it down, which in practice only
/// runs when the root [ProviderScope] itself is disposed (app shutdown, or a test's `container.dispose()`).
final realtimeClientProvider = Provider<RealtimeClient>((ref) {
  final networkConfig = ref.watch(networkConfigProvider);
  final getToken = ref.watch(realtimeTokenProvider);

  final client = RealtimeClient(
    baseUrl: networkConfig.realtimeBaseUrl,
    getToken: getToken,
  );
  ref.onDispose(client.dispose);
  client.connect();
  return client;
});

class _RealtimeConnectionStatusNotifier
    extends Notifier<RealtimeConnectionStatus> {
  StreamSubscription<RealtimeConnectionStatus>? _subscription;

  @override
  RealtimeConnectionStatus build() {
    final client = ref.watch(realtimeClientProvider);
    _subscription = client.statusStream.listen((status) => state = status);
    ref.onDispose(() => _subscription?.cancel());
    return client.status;
  }
}

/// Live [RealtimeConnectionStatus], for a "live"/"reconnecting" indicator or for a feature
/// provider to detect "the connection just came back" and reconcile its own state — see this
/// file's top-level doc comment for the exact pattern.
final realtimeConnectionStatusProvider =
    NotifierProvider<
      _RealtimeConnectionStatusNotifier,
      RealtimeConnectionStatus
    >(_RealtimeConnectionStatusNotifier.new);

/// Live domain events from the gateway, already validated and deduplicated by [RealtimeClient].
/// This is the "event stream provider" a feature integrates with: `ref.listen` it, filter by
/// `envelope.type`, and invalidate whatever that event affects.
///
/// ```dart
/// ref.listen(realtimeEventsProvider, (previous, next) {
///   final envelope = next.valueOrNull;
///   if (envelope?.type == 'grades.published') {
///     ref.invalidateSelf();
///   }
/// });
/// ```
///
/// A reconnect (including a background/foreground cycle — see [RealtimeClient]'s doc comment) can
/// drop events that were published while the socket was down; this stream alone cannot reconcile
/// that gap; pair it with a `ref.listen(realtimeConnectionStatusProvider, ...)` that invalidates on
/// any transition into [RealtimeConnectionStatus.connected] after the provider's first build.
final realtimeEventsProvider = StreamProvider<EventEnvelope>((ref) {
  final client = ref.watch(realtimeClientProvider);
  return client.events;
});
