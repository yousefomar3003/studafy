import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../di/app_providers.dart';
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

/// The `login_hint` the mock-login affordance passes to the mock IdP (ST-247) — which seeded
/// persona "Continue with Mock" signs in as. `null` in production (the mock IdP falls back to its
/// own `defaultSubject`); the integration_test suite overrides this per test to target a specific
/// persona, the same `ProviderScope.overrides` seam every other test double in this app uses.
final mockLoginHintProvider = Provider<String?>((ref) => null);

// `appConfigProvider` lives in `core/di/app_providers.dart` (`throw StateError` until app
// bootstrap overrides it) — read here rather than hardcoding a base URL, which previously left
// every real device/emulator run of this client pointed at its own loopback instead of the
// configured API host.
final authClientProvider = Provider<MobileAuthClient>((ref) {
  final appConfig = ref.watch(appConfigProvider);
  return MobileAuthClient(baseUrl: appConfig.apiBaseUrl.toString());
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
  ///
  /// [loginHint] only affects the `mock` provider (ST-247): the mock IdP has no account picker of
  /// its own, so whichever seeded persona's email is passed here is who it signs in as — see
  /// `dev/mock-idp.ts`'s `/authorize`. Ignored for `google`/`microsoft`, which resolve the signed-in
  /// identity from the real browser session instead.
  Future<void> login(String provider, {String? loginHint}) async {
    state = AuthStatus.loading;

    try {
      final start = await _authClient.startOAuth(provider);

      final authUrl = _buildAuthorizationUrl(
        provider: provider,
        state: start.state,
        nonce: start.nonce,
        codeChallenge: start.codeChallenge,
        loginHint: loginHint,
      );

      final browser = ref.read(oAuthBrowserProvider);
      final callback = await browser.authorize(authUrl);

      final tokens = await _authClient.exchangeCode(
        provider: provider,
        code: callback.code,
        state: callback.state,
        nonce: start.nonce,
      );

      await _completeLogin(tokens);
    } catch (_) {
      state = AuthStatus.unauthenticated;
    }
  }

  /// Abandon an in-progress [login] — the user closed the browser without signing in, which sends
  /// the app no callback. [login] then settles as a failed sign-in.
  void cancelLogin() => ref.read(oAuthBrowserProvider).cancel();

  /// Email/password sign-in for the App Store / Play reviewer demo accounts (ST-303).
  ///
  /// Unlike [login], this does not pass through [AuthStatus.loading] or swallow failures: the
  /// caller (the login screen's email form) owns its own progress state and turns the thrown
  /// error into a specific message, rather than the generic "cancelled or failed" snackbar that
  /// fits a browser flow the user can abandon.
  Future<void> loginWithEmail({
    required String email,
    required String password,
  }) async {
    final tokens = await _authClient.loginWithEmail(
      email: email,
      password: password,
    );
    await _completeLogin(tokens);
  }

  Future<void> _completeLogin(MobileTokenResponse tokens) async {
    await _session.saveTokens(
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? '',
      sessionId: tokens.sessionId,
      expiresIn: tokens.expiresIn,
    );
    state = AuthStatus.authenticated;
  }

  Future<void> logout() async {
    await _session.logout();
    state = AuthStatus.unauthenticated;
  }

  Future<bool> handleAuthFailure() => _session.handleAuthFailure();

  /// The page the system browser opens: the API's `/mobile-authorize`, which redirects to the
  /// provider with the server's own registered client and redirect URI. The provider returns to
  /// the server's callback, which verifies the identity and sends the browser back to
  /// `studafy://auth/callback` with a one-time code for [MobileAuthClient.exchangeCode] — see
  /// `apps/api/src/modules/auth/oauth/mobile-handoff.ts`. The app never sends a provider its own
  /// redirect URI: the providers' web clients refuse custom schemes.
  ///
  /// [loginHint] only affects the `mock` provider (dev/E2E, ST-247), whose IdP has no account picker.
  Uri _buildAuthorizationUrl({
    required String provider,
    required String state,
    required String nonce,
    required String codeChallenge,
    String? loginHint,
  }) {
    final apiBaseUrl = ref.read(appConfigProvider).apiBaseUrl;
    return apiBaseUrl.replace(
      path: '/api/auth/oauth/$provider/mobile-authorize',
      queryParameters: {
        'state': state,
        'nonce': nonce,
        'code_challenge': codeChallenge,
        'login_hint': ?loginHint,
      },
    );
  }
}

final authNotifierProvider =
    NotifierProvider<AuthNotifier, AuthStatus>(AuthNotifier.new);

final authStatusProvider = Provider<AuthStatus>((ref) {
  return ref.watch(authNotifierProvider);
});
