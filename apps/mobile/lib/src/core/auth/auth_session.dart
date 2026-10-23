import 'dart:async';

import 'package:dio/dio.dart';

import '../api/api_exception.dart';
import 'jwt_payload.dart';
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
  AuthSession({required this._authClient, required this._secureStore});

  final MobileAuthClient _authClient;
  final SecureTokenStore _secureStore;

  String? _accessToken;
  String? _refreshToken;
  DateTime? _accessTokenExpiresAt;
  List<String> _roles = const [];
  String? _userId;
  String? _sessionId;

  String? _lastRefreshErrorCode;

  bool _refreshInProgress = false;
  final Completer<void> _restored = Completer<void>();

  // -- Public API ------------------------------------------------------------

  /// TokenProvider compatible with [AuthInterceptor]. Async because the first
  /// call may need to read from secure storage.
  ///
  /// Renews the access token first when it is within [isExpiringSoon]'s window, so requests don't
  /// go out with a token the API is about to reject (access tokens are short-lived). A renewal
  /// that fails because the network is down leaves the old token in place — the request then
  /// fails on connectivity, not as a sign-out.
  Future<String?> get tokenProvider async {
    if (_accessToken == null) await _restored.future;
    if (_accessToken != null && _refreshToken != null && isExpiringSoon()) {
      await refresh();
    }
    return _accessToken;
  }

  /// Whether the session currently holds a bearer token.
  bool get isAuthenticated => _accessToken != null;

  /// The `roles` claim of the current access token, for routing/UX only (e.g. which shell a
  /// session lands in) — never an authorization decision, since this token is not re-verified
  /// here. Empty when unauthenticated or the claim is missing/malformed.
  List<String> get roles => _roles;

  /// The `sub` claim of the current access token — the user's id, and the only piece of user
  /// identity this app reads out of the token for purposes like crash-report attribution (never
  /// a name or email claim). Null when unauthenticated or the claim is missing/malformed.
  /// The `sub` claim of the current access token — the signed-in user's stable UUID (see
  /// `apps/api/src/modules/auth/jwt/types.ts`'s `AccessTokenClaims.sub`). Same trust posture as
  /// [roles]: for client-side lookups only, never an authorization decision. Null when
  /// unauthenticated or the claim is missing/malformed.
  String? get userId => _userId;

  /// The id of this device's own session — the `id` it has in `GET /api/auth/sessions`. Lets the
  /// signed-in devices screen mark "this device" and keep it out of per-session sign-out. Null
  /// when unauthenticated.
  String? get sessionId => _sessionId;

  /// The problem `code` the server gave for the most recent rejected refresh (for example
  /// `SCHOOL_SUSPENDED` when the school was closed), or `null` when the last refresh succeeded, was
  /// never attempted, or failed without reaching the server. Lets the caller tell *why* a session
  /// ended, after [refresh] has already cleared it.
  String? get lastRefreshErrorCode => _lastRefreshErrorCode;

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
      _sessionId = sessionId;

      // Decode expiry, roles, and user id from the JWT payload.
      // Decode expiry, roles, and subject from the JWT payload.
      final payload = decodeJwtPayload(accessToken);
      _accessTokenExpiresAt = _expiryFromPayload(payload);
      _roles = _rolesFromPayload(payload);
      _userId = _userIdFromPayload(payload);
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
    _sessionId = sessionId;
    _accessTokenExpiresAt = DateTime.now().add(Duration(seconds: expiresIn));
    _lastRefreshErrorCode = null;
    final payload = decodeJwtPayload(accessToken);
    _roles = _rolesFromPayload(payload);
    _userId = _userIdFromPayload(payload);

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
    _roles = const [];
    _userId = null;
    _sessionId = null;
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
    } on DioException catch (error) {
      // Only the server rejecting the refresh token ends the session. A timeout or lost
      // connection must not sign an offline user out; the caller just retries later.
      final status = error.response?.statusCode;
      if (status != null && status >= 400 && status < 500) {
        _lastRefreshErrorCode = error.apiError?.code;
        await clear();
      }
      _refreshCompleter!.complete(false);
      return false;
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

  /// Reads the `exp` claim from an already-decoded JWT payload. `null` for a missing/malformed
  /// claim or a payload that failed to decode.
  static DateTime? _expiryFromPayload(Map<String, dynamic>? payload) {
    final exp = payload?['exp'];
    if (exp is! int) return null;
    return DateTime.fromMillisecondsSinceEpoch(exp * 1000, isUtc: true);
  }

  /// Reads the `roles` claim from an already-decoded JWT payload. Empty for a missing/malformed
  /// claim or a payload that failed to decode.
  static List<String> _rolesFromPayload(Map<String, dynamic>? payload) {
    final roles = payload?['roles'];
    if (roles is! List) return const [];
    return roles.whereType<String>().toList(growable: false);
  }

  /// Reads the `sub` claim from an already-decoded JWT payload. `null` for a missing/malformed
  /// claim or a payload that failed to decode.
  static String? _userIdFromPayload(Map<String, dynamic>? payload) {
    final sub = payload?['sub'];
    return sub is String ? sub : null;
  }
}
