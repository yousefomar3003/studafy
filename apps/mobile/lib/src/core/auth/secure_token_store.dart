import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Typed wrapper around [FlutterSecureStorage] for session tokens.
///
/// iOS stores in Keychain (kSecAttrAccessibleAfterFirstUnlock), Android in
/// EncryptedSharedPreferences backed by Keystore (AES-256-GCM). Tokens never
/// touch SharedPreferences, logs, or any other plain-text sink.
class SecureTokenStore {
  SecureTokenStore({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  static const _keyAccessToken = 'access_token';
  static const _keyRefreshToken = 'refresh_token';
  static const _keySessionId = 'session_id';

  Future<void> save({
    required String accessToken,
    required String refreshToken,
    required String sessionId,
  }) async {
    await Future.wait([
      _storage.write(key: _keyAccessToken, value: accessToken),
      _storage.write(key: _keyRefreshToken, value: refreshToken),
      _storage.write(key: _keySessionId, value: sessionId),
    ]);
  }

  Future<String?> readAccessToken() => _storage.read(key: _keyAccessToken);
  Future<String?> readRefreshToken() => _storage.read(key: _keyRefreshToken);
  Future<String?> readSessionId() => _storage.read(key: _keySessionId);

  Future<void> clear() async {
    await Future.wait([
      _storage.delete(key: _keyAccessToken),
      _storage.delete(key: _keyRefreshToken),
      _storage.delete(key: _keySessionId),
    ]);
  }
}
