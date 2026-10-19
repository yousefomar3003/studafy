import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Typed wrapper around [FlutterSecureStorage] for session tokens.
///
/// iOS stores in the Keychain as `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable by
/// background work after the first unlock, but never synced to iCloud Keychain or restored onto
/// another device from a backup. Android stores in SharedPreferences encrypted with an AES key that
/// is wrapped by an Android Keystore key; that file is excluded from cloud backup and device
/// transfer (see `res/xml/backup_rules.xml` and `res/xml/data_extraction_rules.xml`). Tokens never
/// touch plain SharedPreferences, logs, or any other plain-text sink.
class SecureTokenStore {
  SecureTokenStore({FlutterSecureStorage? storage})
    : _storage =
          storage ??
          const FlutterSecureStorage(
            iOptions: IOSOptions(
              accessibility: KeychainAccessibility.first_unlock_this_device,
            ),
          );

  final FlutterSecureStorage _storage;

  static const _keyAccessToken = 'access_token';
  static const _keyRefreshToken = 'refresh_token';
  static const _keySessionId = 'session_id';

  /// Plain SharedPreferences flag (not a secret) marking that this install has run before.
  static const _keyInstallMarker = 'secure_token_store.installed';

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

  /// Drops tokens left behind by a previous install. Call once at bootstrap, before reading.
  ///
  /// The iOS Keychain outlives an uninstall, so without this a reinstalled app (or one on a phone
  /// that changed hands) would silently sign the previous member back in. SharedPreferences is
  /// wiped with the app, so a missing marker means this is the first launch of this install.
  Future<void> discardIfReinstalled() async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(_keyInstallMarker) ?? false) return;
    await clear();
    await prefs.setBool(_keyInstallMarker, true);
  }
}
