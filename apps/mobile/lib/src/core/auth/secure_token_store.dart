import 'dart:convert';

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

  /// The other accounts signed in on this device, as JSON (`saved_account.dart`). They hold
  /// refresh tokens, so they live here rather than in SharedPreferences.
  static const _keySavedAccounts = 'saved_accounts';

  /// Member ID -> the device token the API gave this device when that member signed in, as JSON.
  /// Kept across sign-out on purpose: it is what lets this phone sign in while strangers' wrong
  /// guesses have the account locked (`member-password-service.ts`, trusted devices).
  static const _keyMemberDeviceTokens = 'member_device_tokens';

  /// The Studafy ID the member chose to have remembered ("Remember me" on the sign-in form), so the
  /// form opens with it filled in. Only the ID: a password is never stored anywhere on the device.
  /// Kept across sign-out on purpose, like the device tokens; dropped on reinstall.
  static const _keyRememberedMemberId = 'remembered_member_id';

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

  /// Clears the active session only; saved accounts are kept.
  Future<void> clear() async {
    await Future.wait([
      _storage.delete(key: _keyAccessToken),
      _storage.delete(key: _keyRefreshToken),
      _storage.delete(key: _keySessionId),
    ]);
  }

  Future<String?> readSavedAccounts() => _storage.read(key: _keySavedAccounts);

  /// Replaces the saved accounts; `null` removes them.
  Future<void> writeSavedAccounts(String? json) => json == null
      ? _storage.delete(key: _keySavedAccounts)
      : _storage.write(key: _keySavedAccounts, value: json);

  /// The device token for [memberId] (case-insensitive), or null if this device has none.
  Future<String?> readMemberDeviceToken(String memberId) async =>
      (await _readMemberDeviceTokens())[_normalizeMemberId(memberId)];

  /// Stores [token] as this device's token for [memberId].
  Future<void> writeMemberDeviceToken(String memberId, String token) async {
    final tokens = await _readMemberDeviceTokens();
    tokens[_normalizeMemberId(memberId)] = token;
    await _storage.write(
      key: _keyMemberDeviceTokens,
      value: jsonEncode(tokens),
    );
  }

  Future<Map<String, String>> _readMemberDeviceTokens() async {
    final raw = await _storage.read(key: _keyMemberDeviceTokens);
    if (raw == null) return {};
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return {};
      return {
        for (final entry in decoded.entries)
          if (entry.key is String && entry.value is String)
            entry.key as String: entry.value as String,
      };
    } on FormatException {
      return {};
    }
  }

  /// The Studafy ID remembered on this device, or null.
  Future<String?> readRememberedMemberId() =>
      _storage.read(key: _keyRememberedMemberId);

  /// Remembers [memberId] for the sign-in form; `null` forgets it.
  Future<void> writeRememberedMemberId(String? memberId) {
    final value = memberId?.trim();
    return value == null || value.isEmpty
        ? _storage.delete(key: _keyRememberedMemberId)
        : _storage.write(key: _keyRememberedMemberId, value: value);
  }

  static String _normalizeMemberId(String memberId) =>
      memberId.trim().toUpperCase();

  /// Drops tokens left behind by a previous install. Call once at bootstrap, before reading.
  ///
  /// The iOS Keychain outlives an uninstall, so without this a reinstalled app (or one on a phone
  /// that changed hands) would silently sign the previous member back in. SharedPreferences is
  /// wiped with the app, so a missing marker means this is the first launch of this install.
  Future<void> discardIfReinstalled() async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(_keyInstallMarker) ?? false) return;
    await Future.wait([
      clear(),
      writeSavedAccounts(null),
      _storage.delete(key: _keyMemberDeviceTokens),
      _storage.delete(key: _keyRememberedMemberId),
    ]);
    await prefs.setBool(_keyInstallMarker, true);
  }
}
