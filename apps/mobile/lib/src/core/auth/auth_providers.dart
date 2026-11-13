export 'auth_notifier.dart'
    show
        authSessionProvider,
        authClientProvider,
        secureTokenStoreProvider,
        oAuthBrowserProvider,
        authNotifierProvider,
        authStatusProvider;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../di/app_providers.dart';
import '../realtime/realtime_client.dart';
import 'auth_notifier.dart';

// ---------------------------------------------------------------------------
// API client — wired to the auth session's token provider
// ---------------------------------------------------------------------------

/// Bumped when the server starts answering this same session differently: accepting the Terms of
/// Service (or cancelling a scheduled deletion) lifts a refusal the API applied to every request.
/// Screens that loaded while it applied hold that 403 as a cached error, and the session object
/// itself does not change, so nothing would refetch. [apiClientProvider] and [authenticatedDio]
/// watch this, so a bump rebuilds every provider built on them and they load again.
class SessionDataEpoch extends Notifier<int> {
  @override
  int build() => 0;

  void bump() => state++;
}

final sessionDataEpochProvider = NotifierProvider<SessionDataEpoch, int>(
  SessionDataEpoch.new,
);

final apiClientProvider = Provider<StudafyApiClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  ref.watch(sessionDataEpochProvider);

  return createApiClient(
    baseUrl: baseUrl,
    getToken: () => session.tokenProvider,
    onUnauthorized: () =>
        ref.read(authNotifierProvider.notifier).handleAuthFailure(),
    onSchoolClosed: () =>
        ref.read(authNotifierProvider.notifier).handleSchoolClosed(),
  );
});

// ---------------------------------------------------------------------------
// Realtime — override the token seam so WebSocket carries the bearer
// ---------------------------------------------------------------------------

final realtimeAuthOverride = Provider<RealtimeTokenProvider>((ref) {
  final session = ref.watch(authSessionProvider);
  return () => session.tokenProvider;
});
