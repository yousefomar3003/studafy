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

final apiClientProvider = Provider<StudafyApiClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);

  return createApiClient(
    baseUrl: baseUrl,
    getToken: () => session.tokenProvider,
  );
});

// ---------------------------------------------------------------------------
// Realtime — override the token seam so WebSocket carries the bearer
// ---------------------------------------------------------------------------

final realtimeAuthOverride = Provider<RealtimeTokenProvider>((ref) {
  final session = ref.watch(authSessionProvider);
  return () => session.tokenProvider;
});
