import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'auth_notifier.dart' show secureTokenStoreProvider;

/// How the person is shown in the account switcher and on the login screen. Captured from the
/// profile while the account is active, because a set-aside account cannot ask the API.
class AccountLabel {
  const AccountLabel({
    this.displayName,
    this.schoolName,
    this.memberIds = const [],
  });

  final String? displayName;
  final String? schoolName;
  final List<String> memberIds;
}

/// An account signed in on this device but not the active one — the session itself, set aside
/// so switching back needs no password. One person can hold an account at several schools (a
/// parent with children at two schools); each school's account is its own user.
class SavedAccount {
  const SavedAccount({
    required this.userId,
    required this.accessToken,
    required this.refreshToken,
    required this.sessionId,
    required this.roles,
    required this.label,
  });

  final String userId;
  final String accessToken;
  final String refreshToken;
  final String sessionId;

  /// The `roles` claim when it was set aside, for the role label only.
  final List<String> roles;
  final AccountLabel label;

  Map<String, dynamic> toJson() => {
    'user_id': userId,
    'access_token': accessToken,
    'refresh_token': refreshToken,
    'session_id': sessionId,
    'roles': roles,
    'display_name': label.displayName,
    'school_name': label.schoolName,
    'member_ids': label.memberIds,
  };

  /// `null` for an entry this version cannot read, so one bad entry doesn't lose the rest.
  static SavedAccount? fromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final userId = json['user_id'];
    final accessToken = json['access_token'];
    final refreshToken = json['refresh_token'];
    final sessionId = json['session_id'];
    if (userId is! String ||
        accessToken is! String ||
        refreshToken is! String ||
        sessionId is! String) {
      return null;
    }
    List<String> strings(Object? value) =>
        value is List ? value.whereType<String>().toList() : const [];
    return SavedAccount(
      userId: userId,
      accessToken: accessToken,
      refreshToken: refreshToken,
      sessionId: sessionId,
      roles: strings(json['roles']),
      label: AccountLabel(
        displayName: json['display_name'] as String?,
        schoolName: json['school_name'] as String?,
        memberIds: strings(json['member_ids']),
      ),
    );
  }
}

/// The accounts set aside on this device, most recently used first. Persisted in
/// [SecureTokenStore]; [AuthNotifier] is the only writer.
class SavedAccountsNotifier extends Notifier<List<SavedAccount>> {
  /// Every change waits for this, so a write can't be overwritten by the initial read.
  late Future<void> _loaded;

  @override
  List<SavedAccount> build() {
    _loaded = _load();
    return const [];
  }

  Future<void> _load() async {
    try {
      final raw = await ref.read(secureTokenStoreProvider).readSavedAccounts();
      if (raw == null) return;
      final decoded = jsonDecode(raw);
      if (decoded is List) {
        state = decoded
            .map(SavedAccount.fromJson)
            .whereType<SavedAccount>()
            .toList();
      }
    } catch (_) {
      // Unreadable (corrupt, or the Keychain refused): start with none rather than block sign-in.
    }
  }

  Future<SavedAccount?> find(String userId) async {
    await _loaded;
    for (final account in state) {
      if (account.userId == userId) return account;
    }
    return null;
  }

  /// Adds [account] at the front, replacing an older entry for the same user.
  Future<void> put(SavedAccount account) async {
    await _loaded;
    await _save([
      account,
      ...state.where((saved) => saved.userId != account.userId),
    ]);
  }

  Future<void> remove(String userId) async {
    await _loaded;
    final remaining = state.where((saved) => saved.userId != userId).toList();
    if (remaining.length != state.length) await _save(remaining);
  }

  Future<void> _save(List<SavedAccount> accounts) async {
    state = accounts;
    await ref
        .read(secureTokenStoreProvider)
        .writeSavedAccounts(
          accounts.isEmpty
              ? null
              : jsonEncode([for (final account in accounts) account.toJson()]),
        );
  }
}

final savedAccountsProvider =
    NotifierProvider<SavedAccountsNotifier, List<SavedAccount>>(
      SavedAccountsNotifier.new,
    );
