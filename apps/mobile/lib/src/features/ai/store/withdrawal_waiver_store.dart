import 'package:shared_preferences/shared_preferences.dart';

/// Keeps the student's withdrawal waiver until the purchase it was given for is registered.
///
/// The waiver is given on the purchase screen, but the purchase reaches the app later — moments
/// later, or on the next launch when the server could not be reached, or days later when a parent
/// approves an Ask to Buy / Family Link request. Kept on the device in between, so the purchase is
/// still sent with it. Not a secret: a timestamp. Plain SharedPreferences, wiped with the app.
abstract interface class WithdrawalWaiverStore {
  /// When the student gave the waiver for the purchase in progress, or null.
  Future<DateTime?> read();

  Future<void> save(DateTime acknowledgedAt);

  Future<void> clear();
}

class SharedPreferencesWithdrawalWaiverStore implements WithdrawalWaiverStore {
  static const _key = 'aiStore.withdrawalWaiverAcknowledgedAt';

  @override
  Future<DateTime?> read() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final value = prefs.getString(_key);
      return value == null ? null : DateTime.tryParse(value);
    } on Object {
      return null;
    }
  }

  @override
  Future<void> save(DateTime acknowledgedAt) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, acknowledgedAt.toUtc().toIso8601String());
    } on Object {
      // Kept in memory by the controller for this run; only a relaunch before registering loses it.
    }
  }

  @override
  Future<void> clear() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_key);
    } on Object {
      // Nothing to do: a stale waiver is only ever sent with a purchase, never on its own.
    }
  }
}
