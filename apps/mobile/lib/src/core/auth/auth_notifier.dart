import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../di/app_providers.dart';
import 'auth_session.dart';
import 'auth_state.dart';
import 'oauth_browser.dart';
import 'oauth_client.dart';
import 'school_closed_notice.dart';
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

  /// The sign-out in flight for a closed school, shared by every caller that hits it meanwhile —
  /// a screen's parallel requests all fail with SCHOOL_SUSPENDED at once.
  Future<void>? _schoolClosedSignOut;

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
    } catch (error) {
      if (isSchoolClosedError(error)) {
        ref.read(schoolClosedNoticeProvider.notifier).show();
      }
      state = AuthStatus.unauthenticated;
    }
  }

  /// Abandon an in-progress [login] — the user closed the browser without signing in, which sends
  /// the app no callback. [login] then settles as a failed sign-in.
  void cancelLogin() => ref.read(oAuthBrowserProvider).cancel();

  /// Member-ID + password sign-in. Unlike [login], this does not pass through
  /// [AuthStatus.loading] or swallow failures: the caller owns progress and error display; a 403 `AUTH_PASSWORD_CHANGE_REQUIRED` is rethrown so the form can ask for a new
  /// password and call again with [newPassword].
  Future<void> loginWithMember({
    required String username,
    required String password,
    String? newPassword,
  }) async {
    final MobileTokenResponse tokens;
    try {
      tokens = await _authClient.loginWithMember(
        username: username,
        password: password,
        newPassword: newPassword,
      );
    } catch (error) {
      if (isSchoolClosedError(error)) {
        ref.read(schoolClosedNoticeProvider.notifier).show();
      }
      rethrow;
    }
    await _completeLogin(tokens);
  }

  Future<void> _completeLogin(MobileTokenResponse tokens) async {
    await _session.saveTokens(
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? '',
      sessionId: tokens.sessionId,
      expiresIn: tokens.expiresIn,
    );
    ref.read(schoolClosedNoticeProvider.notifier).clear();
    state = AuthStatus.authenticated;
  }

  Future<void> logout() async {
    await _session.logout();
    state = AuthStatus.unauthenticated;
  }

  /// The account was just deleted (`POST /api/account/deletion`): the server has already revoked
  /// every session, so clear this device's tokens without calling the logout endpoint.
  Future<void> handleAccountDeleted() async {
    await _session.clear();
    state = AuthStatus.unauthenticated;
  }

  /// The API rejected the access token: renew it once. When the session can't be renewed (the
  /// refresh token expired or was revoked), sign out so the router returns to the login screen
  /// instead of leaving every screen failing with 401s.
  Future<bool> handleAuthFailure() async {
    final renewed = await _session.handleAuthFailure();
    if (!renewed && _session.lastRefreshErrorCode == schoolClosedErrorCode) {
      await handleSchoolClosed();
      return false;
    }
    if (!renewed && state == AuthStatus.authenticated) {
      await _session.clear();
      state = AuthStatus.unauthenticated;
    }
    return renewed;
  }

  /// The API answered SCHOOL_SUSPENDED: the school was closed, so this session is over for good.
  /// Sign out locally — the server has already revoked every session in the school, so there is
  /// nothing to tell it — and have the login screen say why.
  ///
  /// Safe to call from many failing requests at once: they all share one sign-out.
  Future<void> handleSchoolClosed() {
    ref.read(schoolClosedNoticeProvider.notifier).show();
    return _schoolClosedSignOut ??= _signOutClosedSchool().whenComplete(
      () => _schoolClosedSignOut = null,
    );
  }

  Future<void> _signOutClosedSchool() async {
    await _session.clear();
    if (state != AuthStatus.unauthenticated) state = AuthStatus.unauthenticated;
  }

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

final authNotifierProvider = NotifierProvider<AuthNotifier, AuthStatus>(
  AuthNotifier.new,
);

final authStatusProvider = Provider<AuthStatus>((ref) {
  return ref.watch(authNotifierProvider);
});
