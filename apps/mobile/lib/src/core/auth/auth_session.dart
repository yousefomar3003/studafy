import 'dart:async';
import 'dart:convert';

import 'oauth_client.dart';
import 'secure_token_store.dart';

/// In-memory token state with secure storage backing.
///
/// Tokens live in memory for fast synchronous access (the [tokenProvider] called
/// by [AuthInterceptor] on every request) and are persisted to
/// [SecureTokenStore] (Keychain / Keystore) for survival across app restarts.
///
/// On startup, call [restore] to hydrate the in-memory state from secure
/// storage. The [tokenProvider] getter is safe to call before [restore] — it
/// simply returns null, which makes the app behave as unauthenticated.
class AuthSession {
  AuthSession({
    required this._authClient,
    required this._secureStore,
  });

  final MobileAuthClient _authClient;
  final SecureTokenStore _secureStore;

  String? _accessToken;
  String? _refreshToken;
  DateTime? _accessTokenExpiresAt;

  bool _refreshInProgress = false;
  final Completer<void> _restored = Completer<void>();

  // -- Public API ------------------------------------------------------------

  /// TokenProvider compatible with [AuthInterceptor]. Async because the first
  /// call may need to read from secure storage.
  Future<String?> get tokenProvider async {
    if (_accessToken != null) return _accessToken;
    await _restored.future;
    return _accessToken;
  }

  /// Whether the session currently holds a bearer token.
  bool get isAuthenticated => _accessToken != null;

  /// Whether the session has been restored from secure storage.
  bool get isRestored => _restored.isCompleted;

  /// Hydrate in-memory state from secure storage. Call once at bootstrap.
  Future<void> restore() async {
    if (_restored.isCompleted) return;

    final results = await Future.wait([
      _secureStore.readAccessToken(),
      _secureStore.readRefreshToken(),
      _secureStore.readSessionId(),
    ]);

    final accessToken = results[0];
    final refreshToken = results[1];
    final sessionId = results[2];

    if (accessToken != null && refreshToken != null && sessionId != null) {
      _accessToken = accessToken;
      _refreshToken = refreshToken;

      // Decode expiry from the JWT payload.
      _accessTokenExpiresAt = _decodeExpiry(accessToken);
    }

    _restored.complete();
  }

  /// Persist tokens after a successful login or refresh.
  Future<void> saveTokens({
    required String accessToken,
    required String refreshToken,
    required String sessionId,
    required int expiresIn,
  }) async {
    _accessToken = accessToken;
    _refreshToken = refreshToken;
    _accessTokenExpiresAt = DateTime.now().add(Duration(seconds: expiresIn));

    await _secureStore.save(
      accessToken: accessToken,
      refreshToken: refreshToken,
      sessionId: sessionId,
    );
  }

  /// Clear all tokens — in-memory and on disk.
  Future<void> clear() async {
    _accessToken = null;
    _refreshToken = null;
    _accessTokenExpiresAt = null;
    await _secureStore.clear();
  }

  /// Attempt a silent refresh using the stored refresh token.
  ///
  /// Returns true on success, false if the refresh token is expired/revoked
  /// (caller should force-logout).
  Future<bool> refresh() async {
    if (_refreshToken == null) return false;
    if (_refreshInProgress) return _refreshCompleter!.future;

    _refreshInProgress = true;
    _refreshCompleter = Completer<bool>();

    try {
      final response = await _authClient.refreshSession(_refreshToken!);
      await saveTokens(
        accessToken: response.accessToken,
        refreshToken: response.refreshToken ?? _refreshToken!,
        sessionId: response.sessionId,
        expiresIn: response.expiresIn,
      );
      _refreshCompleter!.complete(true);
      return true;
    } catch (_) {
      await clear();
      _refreshCompleter!.complete(false);
      return false;
    } finally {
      _refreshInProgress = false;
    }
  }

  Completer<bool>? _refreshCompleter;

  /// Whether the access token is close to expiring (within [window]).
  ///
  /// Used by [refreshIfNeeded] to decide whether to refresh eagerly.
  bool isExpiringSoon({Duration window = const Duration(minutes: 2)}) {
    if (_accessTokenExpiresAt == null) return true;
    return DateTime.now().add(window).isAfter(_accessTokenExpiresAt!);
  }

  /// Refresh the access token if it's close to expiring. No-op if a refresh is
  /// already in progress.
  Future<void> refreshIfNeeded() async {
    if (isExpiringSoon() && _refreshToken != null) {
      await refresh();
    }
  }

  /// Notify the session that the server rejected the access token (401).
  ///
  /// Attempts one silent refresh. Returns true if the caller should retry the
  /// original request, false if the session is dead (force-logout).
  Future<bool> handleAuthFailure() async {
    if (_refreshToken == null) return false;
    return refresh();
  }

  /// Logout: tell the server to revoke the token family, then clear locally.
  Future<void> logout() async {
    final refreshToken = _refreshToken;
    if (refreshToken != null) {
      try {
        await _authClient.logout(refreshToken);
      } catch (_) {
        // Logout is best-effort — always clear locally regardless.
      }
    }
    await clear();
  }

  // -- Helpers ---------------------------------------------------------------

  /// Decode the `exp` claim from a JWT without verifying the signature.
  /// The server is the source of truth for token validity; this is only used
  /// for client-side "refresh soon" heuristic.
  static DateTime? _decodeExpiry(String jwt) {
    try {
      final parts = jwt.split('.');
      if (parts.length != 3) return null;

      final payload = utf8.decode(base64Url.decode(parts[1]));
      final claims = Map<String, dynamic>.from(
        jsonDecode(payload) as Map<String, dynamic>,
      );

      final exp = claims['exp'];
      if (exp is int) {
        return DateTime.fromMillisecondsSinceEpoch(exp * 1000, isUtc: true);
      }
      return null;
    } catch (_) {
      return null;
    }
  }
}
