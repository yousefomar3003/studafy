import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../di/app_providers.dart';
import 'protocol.dart';
import 'realtime_client.dart';

/// Supplies the realtime handshake ticket for the active session (QA-14). Unoverridden it resolves
/// none, so [realtimeClientProvider] stays [RealtimeConnectionStatus.unauthorized], same as being
/// signed out; that is the state tests start in. App bootstrap (`core/config/app_bootstrap.dart`)
/// overrides it with [realtimeTicketProvider] over the authenticated Dio, which asks the API for a
/// fresh ticket on every connect attempt.
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
///   final envelope = next.value; // AsyncValue<T>.value is nullable in riverpod 3.x
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
