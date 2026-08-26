import 'package:studafy_mobile/src/core/auth/secure_token_store.dart';

/// An in-memory [SecureTokenStore] double.
///
/// [SecureTokenStore] wraps `flutter_secure_storage`'s platform channel, which has no handler
/// registered under `flutter test` — any real read/write throws `MissingPluginException`. This
/// overrides every method so tests never touch that channel, while still exercising
/// [AuthSession]'s real restore/save/clear logic against a plain in-memory backing.
class FakeSecureTokenStore extends SecureTokenStore {
  String? _accessToken;
  String? _refreshToken;
  String? _sessionId;

  @override
  Future<void> save({
    required String accessToken,
    required String refreshToken,
    required String sessionId,
  }) async {
    _accessToken = accessToken;
    _refreshToken = refreshToken;
    _sessionId = sessionId;
  }

  @override
  Future<String?> readAccessToken() async => _accessToken;

  @override
  Future<String?> readRefreshToken() async => _refreshToken;

  @override
  Future<String?> readSessionId() async => _sessionId;

  @override
  Future<void> clear() async {
    _accessToken = null;
    _refreshToken = null;
    _sessionId = null;
  }
}
