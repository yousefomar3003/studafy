import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// Which of a parent's children have their own account on this phone, from "Add (child) to this
/// phone": the child's student record id -> the child's user id.
///
/// The parent app only knows a child by the student record id, while the account switcher knows
/// accounts by user id; this is the bridge between the two, so the button can say "Open (name)"
/// once the child's account is on the phone. Kept per parent (one phone, two parents) in
/// SharedPreferences: nothing here is a secret (two ids), it has to survive switching to the
/// child's account and back -- which the offline database, wiped per account, would not -- and a
/// reinstall clears it along with the saved accounts it points at.
class ChildDeviceAccountsStore {
  static String _key(String parentUserId) =>
      'guardian_child_accounts.$parentUserId';

  Future<Map<String, String>> load(String parentUserId) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key(parentUserId));
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

  Future<void> remember(
    String parentUserId,
    String studentId,
    String childUserId,
  ) async {
    final prefs = await SharedPreferences.getInstance();
    final accounts = await load(parentUserId);
    accounts[studentId] = childUserId;
    await prefs.setString(_key(parentUserId), jsonEncode(accounts));
  }
}
