import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'auth_session.dart';
import 'auth_state.dart';
import 'oauth_browser.dart';
import 'oauth_client.dart';
import 'secure_token_store.dart';

// ---------------------------------------------------------------------------
// Provider declarations (lives here to avoid circular import with
// auth_providers.dart, which re-exports this file's providers).
// ---------------------------------------------------------------------------

final secureTokenStoreProvider = Provider<SecureTokenStore>((ref) {
  return SecureTokenStore();
});

final oAuthBrowserProvider = Provider<OAuthBrowser>((ref) {
  return OAuthBrowser();
});

final authClientProvider = Provider<MobileAuthClient>((ref) {
  return MobileAuthClient(baseUrl: 'http://localhost');
});

final authSessionProvider = Provider<AuthSession>((ref) {
  final authClient = ref.watch(authClientProvider);
  final secureStore = ref.watch(secureTokenStoreProvider);
  return AuthSession(authClient: authClient, secureStore: secureStore);
});

// ---------------------------------------------------------------------------
// Auth state machine
// ---------------------------------------------------------------------------

class AuthNotifier extends Notifier<AuthStatus> {
  late final AuthSession _session;
  late final MobileAuthClient _authClient;

  @override
  AuthStatus build() {
    _authClient = ref.read(authClientProvider);
    _session = ref.read(authSessionProvider);

    _restore();

    return AuthStatus.loading;
  }

  Future<void> _restore() async {
    await _session.restore();
    state = _session.isAuthenticated
        ? AuthStatus.authenticated
        : AuthStatus.unauthenticated;
  }

  /// Trigger the full OIDC browser flow for the given provider.
  Future<void> login(String provider) async {
    state = AuthStatus.loading;

    try {
      final start = await _authClient.startOAuth(provider);

      final authUrl = _buildAuthorizationUrl(
        provider: provider,
        state: start.state,
        nonce: start.nonce,
        codeChallenge: start.codeChallenge,
      );

      final browser = ref.read(oAuthBrowserProvider);
      final callback = await browser.authorize(authUrl);

      final tokens = await _authClient.exchangeCode(
        provider: provider,
        code: callback.code,
        state: callback.state,
        nonce: start.nonce,
      );

      await _session.saveTokens(
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? '',
        sessionId: tokens.sessionId,
        expiresIn: tokens.expiresIn,
      );

      state = AuthStatus.authenticated;
    } catch (_) {
      state = AuthStatus.unauthenticated;
    }
  }

  Future<void> logout() async {
    await _session.logout();
    state = AuthStatus.unauthenticated;
  }

  Future<bool> handleAuthFailure() => _session.handleAuthFailure();

  Uri _buildAuthorizationUrl({
    required String provider,
    required String state,
    required String nonce,
    required String codeChallenge,
  }) {
    final browser = ref.read(oAuthBrowserProvider);
    final redirectUri = browser.redirectUri;

    if (provider == 'google') {
      return Uri.https('accounts.google.com', '/o/oauth2/v2/auth', {
        'client_id': _googleClientId,
        'redirect_uri': redirectUri.toString(),
        'response_type': 'code',
        'scope': 'openid email profile',
        'state': state,
        'nonce': nonce,
        'code_challenge': codeChallenge,
        'code_challenge_method': 'S256',
        'access_type': 'offline',
      });
    }

    return Uri.https(
      'login.microsoftonline.com',
      '/common/oauth2/v2.0/authorize',
      {
        'client_id': _microsoftClientId,
        'redirect_uri': redirectUri.toString(),
        'response_type': 'code',
        'scope': 'openid email profile',
        'state': state,
        'nonce': nonce,
        'code_challenge': codeChallenge,
        'code_challenge_method': 'S256',
        'response_mode': 'query',
      },
    );
  }

  String get _googleClientId =>
      const String.fromEnvironment('GOOGLE_CLIENT_ID');

  String get _microsoftClientId =>
      const String.fromEnvironment('MICROSOFT_CLIENT_ID');
}

final authNotifierProvider =
    NotifierProvider<AuthNotifier, AuthStatus>(AuthNotifier.new);

final authStatusProvider = Provider<AuthStatus>((ref) {
  return ref.watch(authNotifierProvider);
});
